'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { createInventoryStore } = require('../src/inventory-store');

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbot-inventory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'nested', 'inventory.sqlite');
}

test('inventory commands persist changes across process restarts', t => {
  const filename = temporaryDatabase(t);
  const commandPath = path.resolve(__dirname, '../src/commands/inv.js');
  function run(script) {
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const inv = require(${JSON.stringify(commandPath)});
      ${script}
    `], {
      env: { ...process.env, INVENTORY_DB_PATH: filename },
      stdio: 'pipe',
    });
  }

  run(`
    assert.deepEqual(inv.getInventory('76561198874586215'), []);
    inv.setInventory('76561198000000001', ['Key', 'Key', "Captain's ❄️ Hat"]);
    inv.addInventoryItem('76561198000000001', 'Bottle');
    inv.updateInventory('76561198000000002', ['Old item']);
    inv.updateInventory('76561198000000002', ['Replacement']);
    inv.updateInventory('76561198000000002', 'New item', true);
    assert.equal(inv.transferInventoryItem('76561198000000001', '76561198000000002', ' key '), true);
    assert.equal(inv.reserveInventoryItem('76561198000000001', 'KEY', 'accepted'), 'Key');
    assert.equal(inv.transferReservedInventoryItem('accepted', '76561198000000002'), true);
    assert.deepEqual(inv.getReservations('76561198000000001'), []);
    assert.equal(inv.transferReservedInventoryItem('accepted', '76561198000000002'), false);
    inv.reserveInventoryItem('76561198000000001', 'Bottle', 'pending');
    assert.deepEqual(inv.getAvailableInventory('76561198000000001'), ["Captain's ❄️ Hat"]);
    inv.setInventory('empty', []);
  `);

  run(`
    assert.deepEqual(inv.getInventory('76561198000000001'), ["Captain's ❄️ Hat", 'Bottle']);
    assert.deepEqual(inv.getInventory('76561198000000002'), ['Replacement', 'New item', 'Key', 'Key']);
    assert.deepEqual(inv.getInventory('empty'), []);
    assert.deepEqual(inv.getReservations('76561198000000001'), [
      { offerId: 'pending', steamId: '76561198000000001', item: 'Bottle' },
    ]);
    assert.deepEqual(inv.getAvailableInventory('76561198000000001'), ["Captain's ❄️ Hat"]);
    assert.match(inv.spyInventory('76561198000000002'), /Replacement/);
  `);
});

test('failed recipient writes roll back the sender inventory', t => {
  const filename = temporaryDatabase(t);
  const store = createInventoryStore(filename);
  try {
    store.set('sender', ['Key', 'Key']);
    store.set('recipient', ['Hat']);

    const db = new Database(filename);
    try {
      db.exec(`
        CREATE TRIGGER reject_recipient BEFORE UPDATE ON inventories
        WHEN NEW.steam_id = 'recipient'
        BEGIN SELECT RAISE(ABORT, 'recipient write failed'); END;
      `);
    } finally {
      db.close();
    }

    assert.throws(() => store.transfer('sender', 'recipient', 'Key'), /recipient write failed/);
    assert.deepEqual(store.get('sender'), ['Key', 'Key']);
    assert.deepEqual(store.get('recipient'), ['Hat']);
  } finally {
    store.close();
  }
});

test('inventory copies, missing items and self-transfers preserve ownership', t => {
  const store = createInventoryStore(':memory:');
  t.after(() => store.close());
  const steamId = { toString: () => '76561198000000001' };
  const items = ['Key', 'Key', 'Hat'];
  store.set(steamId, items);
  items.push('Not saved');
  store.get(steamId).pop();
  assert.deepEqual(store.get(String(steamId)), ['Key', 'Key', 'Hat']);
  assert.equal(store.transfer(steamId, String(steamId), 'KEY'), true);
  assert.deepEqual(store.get(steamId), ['Key', 'Key', 'Hat']);
  assert.equal(store.transfer(steamId, 'other', 'missing'), false);
  assert.equal(store.get('other'), undefined);
  assert.throws(() => store.add(steamId, null), TypeError);
  assert.deepEqual(store.get(steamId), ['Key', 'Key', 'Hat']);
});

test('pending offers survive restarts and decisions cannot be replayed', t => {
  const filename = temporaryDatabase(t);
  const projectPath = path.resolve(__dirname, '..');
  function run(script) {
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { getReply } = require('./src/message-handler');
      const inv = require('./src/commands/inv');
      const sendOffer = require('./src/commands/sendoffer');
      const sender = '76561198000000001';
      const recipient = '76561198000000002';
      (async () => { ${script} })().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    `], {
      cwd: projectPath,
      env: { ...process.env, INVENTORY_DB_PATH: filename },
      stdio: 'pipe',
    });
  }

  run(`
    inv.setInventory(sender, ['Key', 'Key', 'Hat']);
    inv.setInventory(recipient, []);
    for (const item of ['Key', 'Key', 'Hat']) {
      assert.match(await getReply('!sendoffer ' + recipient + ' ' + item, sender), /OFFER CREATED SUCCESSFULLY/);
    }
    assert.equal(sendOffer.ACTIVE_OFFERS.size, 3);
    assert.deepEqual(inv.getAvailableInventory(sender), []);
  `);

  run(`
    const offers = [...sendOffer.ACTIVE_OFFERS.values()];
    assert.equal(offers.length, 3);
    assert.ok(offers.every(offer => offer.created_at instanceof Date && offer.status === 'pending'));
    assert.deepEqual(inv.getAvailableInventory(sender), []);
    assert.match(inv.spyInventory(sender), /Pending offers: 3/);
    assert.match(await getReply('!offers', recipient), /1. 📦 Key/);
    assert.match(await getReply('!accept ' + offers[0].transaction_id, sender), /Only the intended recipient/);
    assert.match(await getReply('!accept', recipient), /CHOOSE AN OFFER TO ACCEPT/);
    assert.match(await getReply('1', recipient), /OFFER ACCEPTED/);
    assert.match(await getReply('!decline ' + offers[1].transaction_id, recipient), /OFFER DECLINED/);
    assert.deepEqual(inv.getInventory(recipient), ['Key']);
    assert.deepEqual(inv.getInventory(sender), ['Key', 'Hat']);
    assert.deepEqual(inv.getAvailableInventory(sender), ['Key']);
  `);

  run(`
    const offers = [...sendOffer.ACTIVE_OFFERS.values()];
    assert.deepEqual(offers.map(offer => offer.status), ['accepted', 'declined', 'pending']);
    assert.ok(offers[0].decided_at instanceof Date);
    assert.ok(offers[1].decided_at instanceof Date);
    assert.match(await getReply('!accept ' + offers[0].transaction_id, recipient), /already accepted/);
    assert.match(await getReply('!accept ' + offers[1].transaction_id, recipient), /already declined/);
    assert.deepEqual(inv.getInventory(recipient), ['Key']);
    assert.deepEqual(inv.getAvailableInventory(sender), ['Key']);
    assert.equal(inv.getReservations(sender).length, 1);
    assert.match(await getReply('!offers', recipient), /1. 📦 Hat/);
  `);
});

test('offer write failures roll back reservations, decisions and ownership', t => {
  const filename = temporaryDatabase(t);
  const store = createInventoryStore(filename);
  const db = new Database(filename);
  const offer = {
    transaction_id: 'offer-1', item: 'Key',
    offeror_sid: 'sender', offeree_sid: 'recipient',
    offeror_name: 'Sender', offeree_name: 'Recipient',
    status: 'pending', created_at: new Date(), decided_at: null,
  };
  try {
    store.set('sender', ['Key']);
    store.set('recipient', []);
    db.exec(`
      CREATE TRIGGER reject_offer BEFORE INSERT ON internal_offers
      BEGIN SELECT RAISE(ABORT, 'offer write failed'); END;
    `);
    assert.throws(() => store.createOffer(offer), /offer write failed/);
    assert.deepEqual(store.getReservations('sender'), []);
    assert.deepEqual(store.getOffers(), []);
    db.exec('DROP TRIGGER reject_offer');

    assert.ok(store.createOffer(offer));
    assert.equal(store.createOffer({ ...offer, transaction_id: 'offer-2' }), null);
    db.exec(`
      CREATE TRIGGER reject_decision BEFORE UPDATE ON internal_offers
      BEGIN SELECT RAISE(ABORT, 'decision write failed'); END;
    `);
    for (const action of ['accepted', 'declined']) {
      assert.throws(() => store.decideOffer('offer-1', 'recipient', action), /decision write failed/);
      assert.deepEqual(store.get('sender'), ['Key']);
      assert.deepEqual(store.get('recipient'), []);
      assert.equal(store.getReservations('sender').length, 1);
      assert.equal(store.getOffers()[0].status, 'pending');
      assert.equal(store.getOffers()[0].decided_at, null);
    }
    db.exec('DROP TRIGGER reject_decision');
    assert.equal(store.decideOffer('offer-1', 'recipient', 'accepted').code, 'decided');
    assert.deepEqual(store.get('recipient'), ['Key']);
    assert.deepEqual(store.getReservations('sender'), []);
  } finally {
    db.close();
    store.close();
  }
});
