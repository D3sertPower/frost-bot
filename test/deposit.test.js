'use strict';

process.env.INVENTORY_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getReply } = require('../src/message-handler');
const deposit = require('../src/commands/deposit');
const { getInventory, setInventory } = require('../src/commands/inv');

function inventoryItems(items, appid = 440, contextid = '2') {
  return items.map((item, index) => ({
    appid,
    contextid,
    assetid: String(1000 + index),
    amount: item.amount ?? 1,
    market_hash_name: item.name,
    tradable: item.tradable ?? true,
  }));
}

class FakeOffer {
  constructor(manager, partner) {
    this.manager = manager;
    this.partner = String(partner);
    this.id = null;
    this.state = 1;
    this.itemsToReceive = [];
    this.message = '';
  }

  addTheirItems(items) {
    this.itemsToReceive.push(...items);
    return items.length;
  }

  setMessage(message) {
    this.message = message;
  }

  send(callback) {
    this.id = this.manager.nextOfferID;
    this.state = this.manager.sendStatus === 'pending' ? 9 : 2;
    this.manager.sentOffers.push(this);
    callback(null, this.manager.sendStatus);
  }
}

class FakeTradeManager extends EventEmitter {
  constructor({ inventory = [], offerID = '987654321', sendStatus = 'sent' } = {}) {
    super();
    this.inventory = inventory;
    this.nextOfferID = offerID;
    this.sendStatus = sendStatus;
    this.inventoryReads = [];
    this.createdOffers = [];
    this.sentOffers = [];
    this.cookies = [];
  }

  setCookies(cookies, callback) {
    this.cookies = [...cookies];
    callback(null);
  }

  getUserInventoryContents(steamID64, appid, contextid, tradableOnly, callback) {
    this.inventoryReads.push({
      steamID64: String(steamID64),
      appid,
      contextid: String(contextid),
      tradableOnly,
    });
    callback(null, this.inventory.filter((item) => !tradableOnly || item.tradable));
  }

  createOffer(partner) {
    const offer = new FakeOffer(this, partner);
    this.createdOffers.push(offer);
    return offer;
  }
}

function configureMockSteam(options = {}) {
  const client = new EventEmitter();
  if (options.notifications) {
    client.chat = {
      async sendFriendMessage(recipient, message) {
        options.notifications.push({ recipient: String(recipient), message });
      },
    };
  }

  const manager = new FakeTradeManager(options);
  deposit.configureSteamClient(client, { manager });
  client.emit('webSession', 'session-123', [
    'sessionid=session-123; Path=/',
    'steamLoginSecure=secret; Path=/',
  ]);
  return { client, manager };
}

test('deposit sends a manager offer after inventory selection for one partial-name match', async () => {
  const { manager } = configureMockSteam({
    inventory: inventoryItems([
      { name: 'Mann Co. Supply Crate Key' },
      { name: 'Mann Co. Supply Crate Key' },
      { name: 'Refined Metal' },
    ]),
  });

  const inventoryQuestion = await getReply(
    '!deposit 2 mann co. supp',
    '76561198874586215',
  );

  assert.match(inventoryQuestion, /^\/pre /);
  assert.match(inventoryQuestion, /Which inventory should I use/i);
  assert.match(inventoryQuestion, /Steam Community/);
  assert.match(inventoryQuestion, /Team Fortress 2/);
  assert.match(inventoryQuestion, /Counter-Strike 2/);
  assert.equal(manager.inventoryReads.length, 0);

  const invalidChoice = await getReply('something else', '76561198874586215');
  assert.match(invalidChoice, /did not recognize that inventory/i);
  assert.equal(manager.inventoryReads.length, 0);

  const reply = await getReply('tf2', '76561198874586215');

  assert.match(reply, /DEPOSIT OFFER SENT/);
  assert.match(reply, /Trade offer: #987654321/i);
  assert.match(reply, /2 x Mann Co\. Supply Crate Key/);
  assert.match(reply, /Inventory: Team Fortress 2/);
  assert.deepEqual(manager.inventoryReads, [{
    steamID64: '76561198874586215',
    appid: 440,
    contextid: '2',
    tradableOnly: true,
  }]);

  const [offer] = manager.sentOffers;
  assert.equal(offer.partner, '76561198874586215');
  assert.deepEqual(
    offer.itemsToReceive.map((asset) => asset.assetid),
    ['1000', '1001'],
  );
  assert.match(offer.message, /FrostBot deposit/);
});

test('deposit waits for an index when partial text matches multiple item types', async () => {
  const { manager } = configureMockSteam({
    offerID: '123456789',
    inventory: inventoryItems([
      { name: 'Mann Co. Supply Crate Key' },
      { name: 'Mann Co. Supply Crate Series #30' },
    ]),
  });

  const steamID64 = '76561198874586216';
  const inventoryQuestion = await getReply('!deposit mann co. supp', steamID64);
  assert.match(inventoryQuestion, /Which inventory should I use/i);
  assert.equal(manager.inventoryReads.length, 0);

  const question = await getReply('2', steamID64);

  assert.match(question, /more than one matching item/i);
  assert.match(question, /1\..*Mann Co\. Supply Crate Key/);
  assert.match(question, /2\..*Mann Co\. Supply Crate Series #30/);
  assert.equal(manager.sentOffers.length, 0);

  const reply = await getReply('2', steamID64);

  assert.match(reply, /Trade offer: #123456789/i);
  assert.match(reply, /Mann Co\. Supply Crate Series #30/);
  assert.equal(manager.sentOffers.length, 1);
});

test('deposit accepts more item-name text to resolve a pending match', async () => {
  const { manager } = configureMockSteam({
    offerID: '246813579',
    inventory: inventoryItems([
      { name: 'Mann Co. Supply Crate Key' },
      { name: 'Mann Co. Supply Crate Series #30' },
    ]),
  });

  const steamID64 = '76561198874586218';
  await getReply('!deposit mann co. supp', steamID64);
  await getReply('Team Fortress 2', steamID64);
  const reply = await getReply('crate key', steamID64);

  assert.match(reply, /Trade offer: #246813579/i);
  assert.match(reply, /Mann Co\. Supply Crate Key/);
  assert.equal(manager.sentOffers.length, 1);
});

test('deposit validates quantities before calling the manager', async () => {
  const { manager } = configureMockSteam();

  const reply = await getReply(
    '!deposit 0 Mann Co. Supply Crate Key',
    '76561198874586217',
  );

  assert.match(reply, /DEPOSIT COULD NOT BE COMPLETED/);
  assert.match(reply, /Quantity must be a positive whole number/);
  assert.equal(manager.inventoryReads.length, 0);
  assert.equal(manager.createdOffers.length, 0);
});

for (const scenario of [
  {
    choice: 'steam',
    appid: 753,
    contextid: '6',
    item: 'Steam Gems',
    steamID64: '76561198874586219',
  },
  {
    choice: 'cs2',
    appid: 730,
    contextid: '2',
    item: 'Fracture Case',
    steamID64: '76561198874586220',
  },
]) {
  test(`deposit reads only the selected ${scenario.choice} inventory`, async () => {
    const { manager } = configureMockSteam({
      offerID: `${scenario.appid}123`,
      inventory: inventoryItems(
        [{ name: scenario.item }],
        scenario.appid,
        scenario.contextid,
      ),
    });

    await getReply(`!deposit ${scenario.item}`, scenario.steamID64);
    assert.equal(manager.inventoryReads.length, 0);

    const reply = await getReply(scenario.choice, scenario.steamID64);

    assert.match(reply, new RegExp(`Trade offer: #${scenario.appid}123`, 'i'));
    assert.deepEqual(manager.inventoryReads[0], {
      steamID64: scenario.steamID64,
      appid: scenario.appid,
      contextid: scenario.contextid,
      tradableOnly: true,
    });
    assert.equal(manager.sentOffers[0].itemsToReceive[0].appid, scenario.appid);
    assert.equal(
      manager.sentOffers[0].itemsToReceive[0].contextid,
      scenario.contextid,
    );
  });
}

test('manager acceptance events credit Steam deposits exactly once', async () => {
  const steamID64 = '76561198874586221';
  const notifications = [];
  deposit._test.pendingDeposits.clear();
  setInventory(steamID64, []);

  const { manager } = configureMockSteam({
    offerID: '555000111',
    notifications,
    inventory: inventoryItems([
      { name: 'Mann Co. Supply Crate Key' },
      { name: 'Mann Co. Supply Crate Key' },
    ]),
  });

  await getReply('!deposit 2 Mann Co. Supply Crate Key', steamID64);
  await getReply('tf2', steamID64);

  assert.deepEqual(getInventory(steamID64), []);
  assert.equal(deposit._test.pendingDeposits.get('555000111').status, 'pending');

  manager.emit('sentOfferChanged', { id: '555000111', state: 3 }, 2);
  await new Promise((resolve) => setImmediate(resolve));
  manager.emit('sentOfferChanged', { id: '555000111', state: 3 }, 3);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(getInventory(steamID64), [
    'Mann Co. Supply Crate Key',
    'Mann Co. Supply Crate Key',
  ]);
  assert.equal(deposit._test.pendingDeposits.get('555000111').status, 'credited');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /DEPOSIT ACCEPTED AND CREDITED/);
});
