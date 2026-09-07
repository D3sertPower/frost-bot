'use strict';

process.env.INVENTORY_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getReply, COMMANDS } = require('../src/message-handler');
const sendOffer = require('../src/commands/sendoffer');
const {
  configureSteamClient: configureInventory,
  getInventory,
  setInventory,
} = require('../src/commands/inv');

test('expõe o registro de comandos sem dependência circular', async () => {
  assert.ok(COMMANDS instanceof Map);
  assert.ok(COMMANDS.has('!ping'));
  assert.match(await getReply('!ping'), /^\/code 🏓 Pong!/);
});

test('executa um comando pelo alias', async () => {
  assert.match(await getReply('!p'), /^\/code 🏓 Pong!/);
});

test('aceita espaços e diferenças de maiúsculas', async () => {
  assert.match(await getReply('  !PING  '), /^\/code 🏓 Pong!/);
});

test('ignora mensagens que não são comandos conhecidos', async () => {
  assert.equal(await getReply('oi !ping'), null);
  assert.equal(await getReply('!unknown'), null);
  assert.equal(await getReply(null), null);
});

test('sendoffer busca o inventário e cria uma transação', async () => {
  sendOffer._test.clearOfferState();
  setInventory('76561198874586215', [
    'The Frosty Ban Hammer',
    'Empty Water Bottle',
  ]);
  const reply = await getReply(
    '!sendoffer 76561198000000000 The Frosty Ban Hammer',
    '76561198874586215',
  );

  assert.match(reply, /^\/pre ✅ OFFER CREATED SUCCESSFULLY/);
  assert.match(reply, /Item: The Frosty Ban Hammer/);
  assert.match(reply, /From: You/);
  assert.match(reply, /To: Steam friend/);
  assert.doesNotMatch(reply, /7656119\d{10}/);
});

test('sendoffer recusa item que não pertence ao usuário', async () => {
  sendOffer._test.clearOfferState();
  setInventory('76561198874586215', [
    'The Frosty Ban Hammer',
    'Empty Water Bottle',
  ]);
  const reply = await getReply(
    '!sendoffer 76561198000000000 Imaginary Item',
    '76561198874586215',
  );

  assert.match(reply, /^\/pre 🔍 ITEM NOT AVAILABLE/);
  assert.match(reply, /Requested: Imaginary Item/);
});

test('formata os demais comandos exibidos ao usuário', async () => {
  assert.match(
    await getReply('!inventory', '76561198874586215'),
    /^\/pre 🎒/,
  );
  const help = await getReply('!help');
  assert.match(help, /^\/pre 📚/);
  assert.match(help, /!inventory \[friend name\]/);
  assert.match(help, /another Steam friend's inventory/);
  assert.match(await getReply('!extensions'), /^\/quote 🧩/);
});

test('inventory resolves a multi-word Steam friend name', async () => {
  const requester = '76561198874586215';
  const alice = '76561198000000021';

  configureInventory({
    myFriends: { [alice]: 3 },
    users: { [alice]: { player_name: 'Alice Wonderland' } },
  });
  setInventory(alice, ['Wonderland Key']);

  const reply = await getReply('!inventory Alice Wonderland', requester);

  assert.match(reply, /ALICE WONDERLAND’S INVENTORY/);
  assert.match(reply, /Wonderland Key — available/);
  assert.doesNotMatch(reply, /7656119\d{10}/);
});

test('inventory asks for an index when friend names are ambiguous', async () => {
  const requester = '76561198874586215';
  const alexNorth = '76561198000000022';
  const alexSouth = '76561198000000023';

  require('../src/commands/inv')._test.pendingFriendSelections.clear();
  configureInventory({
    myFriends: { [alexNorth]: 3, [alexSouth]: 3 },
    users: {
      [alexNorth]: { player_name: 'Alex North' },
      [alexSouth]: { player_name: 'Alex South' },
    },
  });
  setInventory(alexNorth, ['North Item']);
  setInventory(alexSouth, ['South Item']);

  const choice = await getReply('!inventory Alex', requester);

  assert.match(choice, /more than one matching Steam friend/i);
  assert.match(choice, /1\. 👤 Alex North/);
  assert.match(choice, /2\. 👤 Alex South/);
  assert.doesNotMatch(choice, /7656119\d{10}/);

  const reply = await getReply('2', requester);
  assert.match(reply, /ALEX SOUTH’S INVENTORY/);
  assert.match(reply, /South Item — available/);
});

test('sendoffer resolves a friend name and inventory marks the item pending', async () => {
  const sender = '76561198874586215';
  const alice = '76561198000000011';
  const bob = '76561198000000012';
  const notifications = [];

  sendOffer._test.clearOfferState();
  setInventory(sender, ['The Frosty Ban Hammer', 'Empty Water Bottle']);
  sendOffer.configureSteamClient({
    myFriends: { [alice]: 3, [bob]: 3 },
    users: {
      [sender]: { player_name: 'Frost Captain' },
      [alice]: { player_name: 'Alice Wonderland' },
      [bob]: { player_name: 'Bob Builder' },
    },
    chat: {
      async sendFriendMessage(steamID64, message) {
        notifications.push({ steamID64: String(steamID64), message });
      },
    },
  });

  const created = await getReply(
    '!sendoffer Alice Wonderland The Frosty Ban Hammer',
    sender,
  );

  assert.match(created, /From: Frost Captain/);
  assert.match(created, /To: Alice Wonderland/);
  assert.doesNotMatch(created, /7656119\d{10}/);
  assert.equal(notifications[0].steamID64, alice);
  assert.match(notifications[0].message, /From: Frost Captain/);
  assert.doesNotMatch(notifications[0].message, /7656119\d{10}/);

  const inventory = await getReply('!inventory', sender);
  assert.match(inventory, /🔒 The Frosty Ban Hammer — pending offer/);
  assert.match(inventory, /📦 Empty Water Bottle — available/);
  assert.match(inventory, /Available: 1/);
  assert.match(inventory, /Pending offers: 1/);

  const unavailable = await getReply(
    '!sendoffer Bob Builder The Frosty Ban Hammer',
    sender,
  );
  assert.match(unavailable, /ITEM NOT AVAILABLE/);
  assert.match(unavailable, /Available: Empty Water Bottle/);
  assert.doesNotMatch(unavailable, /Available: The Frosty Ban Hammer/);

  const [offer] = sendOffer.ACTIVE_OFFERS.values();
  await getReply(`!decline ${offer.transaction_id}`, alice);
  const releasedInventory = await getReply('!inventory', sender);
  assert.match(releasedInventory, /📦 The Frosty Ban Hammer — available/);
  assert.match(releasedInventory, /Pending offers: 0/);
});

test('ambiguous friend names are selected by index without exposing IDs', async () => {
  const sender = '76561198874586215';
  const aliceNorth = '76561198000000013';
  const aliceSouth = '76561198000000014';

  sendOffer._test.clearOfferState();
  setInventory(sender, ['Empty Water Bottle']);
  sendOffer.configureSteamClient({
    myFriends: { [aliceNorth]: 3, [aliceSouth]: 3 },
    users: {
      [sender]: { player_name: 'Frost Captain' },
      [aliceNorth]: { player_name: 'Alice North' },
      [aliceSouth]: { player_name: 'Alice South' },
    },
    chat: { async sendFriendMessage() {} },
  });

  const choice = await getReply(
    '!sendoffer Alice Empty Water Bottle',
    sender,
  );

  assert.match(choice, /more than one friend/i);
  assert.match(choice, /1\. 👤 Alice North/);
  assert.match(choice, /2\. 👤 Alice South/);
  assert.doesNotMatch(choice, /7656119\d{10}/);
  assert.equal(sendOffer.ACTIVE_OFFERS.size, 0);

  const created = await getReply('2', sender);
  const [offer] = sendOffer.ACTIVE_OFFERS.values();

  assert.match(created, /To: Alice South/);
  assert.equal(offer.offeree_sid, aliceSouth);
});

test('offers are accepted or declined through numbered interaction', async () => {
  const sender = '76561198874586215';
  const recipient = '76561198000000024';

  sendOffer._test.clearOfferState();
  setInventory(sender, ['First Item', 'Second Item']);
  setInventory(recipient, []);
  sendOffer.configureSteamClient({
    chat: { async sendFriendMessage() {} },
  });

  await getReply(`!sendoffer ${recipient} First Item`, sender);
  await getReply(`!sendoffer ${recipient} Second Item`, sender);

  const acceptList = await getReply('!accept', recipient);
  assert.match(acceptList, /CHOOSE AN OFFER TO ACCEPT/);
  assert.match(acceptList, /1\. 📦 First Item/);
  assert.match(acceptList, /2\. 📦 Second Item/);
  assert.match(acceptList, /Reply with the offer index to accept it/);
  assert.doesNotMatch(acceptList, /!accept [0-9a-f-]{36}/i);

  const accepted = await getReply('2', recipient);
  assert.match(accepted, /OFFER ACCEPTED/);
  assert.deepEqual(getInventory(recipient), ['Second Item']);

  const offersList = await getReply('!offers', recipient);
  assert.match(offersList, /CHOOSE AN OFFER TO SELECT/);
  assert.match(offersList, /1\. 📦 First Item/);

  const selected = await getReply('1', recipient);
  assert.match(selected, /OFFER SELECTED/);
  assert.match(selected, /Reply "accept"/);
  assert.match(selected, /Reply "decline"/);

  const declined = await getReply('decline', recipient);
  assert.match(declined, /OFFER DECLINED/);
  assert.deepEqual(getInventory(sender), ['First Item']);
  assert.deepEqual(getInventory(recipient), ['Second Item']);
});

test('recipient accepts an offer with no expiry and receives the item', async () => {
  const sender = '76561198874586215';
  const recipient = '76561198000000001';
  const outsider = '76561198000000002';
  const notifications = [];

  sendOffer._test.clearOfferState();
  setInventory(sender, ['The Frosty Ban Hammer']);
  setInventory(recipient, []);
  sendOffer.configureSteamClient({
    chat: {
      async sendFriendMessage(steamID64, message) {
        notifications.push({ steamID64: String(steamID64), message });
      },
    },
  });

  await getReply(
    `!sendoffer ${recipient} The Frosty Ban Hammer`,
    sender,
  );

  const [offer] = sendOffer.ACTIVE_OFFERS.values();
  assert.ok(offer);
  assert.equal(offer.status, 'pending');
  assert.equal(notifications[0].steamID64, recipient);
  assert.match(notifications[0].message, /NEW ITEM OFFER RECEIVED/);
  assert.match(notifications[0].message, /Send !offers/);
  assert.doesNotMatch(notifications[0].message, new RegExp(offer.transaction_id));

  offer.created_at = new Date('2000-01-01T00:00:00Z');
  const unauthorized = await getReply(
    `!accept ${offer.transaction_id}`,
    outsider,
  );
  assert.match(unauthorized, /Only the intended recipient/);
  assert.equal(offer.status, 'pending');

  const reply = await getReply(
    `!accept ${offer.transaction_id}`,
    recipient,
  );

  assert.match(reply, /^\/pre ✅ OFFER ACCEPTED/);
  assert.equal(offer.status, 'accepted');
  assert.ok(offer.decided_at instanceof Date);
  assert.deepEqual(getInventory(sender), []);
  assert.deepEqual(getInventory(recipient), ['The Frosty Ban Hammer']);
  assert.equal(notifications.at(-1).steamID64, sender);
  assert.match(notifications.at(-1).message, /YOUR OFFER WAS ACCEPTED/);
});

test('recipient declines an offer without moving the item', async () => {
  const sender = '76561198874586215';
  const recipient = '76561198000000003';
  const notifications = [];

  sendOffer._test.clearOfferState();
  setInventory(sender, ['Empty Water Bottle']);
  setInventory(recipient, []);
  sendOffer.configureSteamClient({
    chat: {
      async sendFriendMessage(steamID64, message) {
        notifications.push({ steamID64: String(steamID64), message });
      },
    },
  });

  await getReply(`!sendoffer ${recipient} Empty Water Bottle`, sender);
  const [offer] = sendOffer.ACTIVE_OFFERS.values();
  const reply = await getReply(
    `!decline ${offer.transaction_id}`,
    recipient,
  );

  assert.match(reply, /^\/pre ❌ OFFER DECLINED/);
  assert.equal(offer.status, 'declined');
  assert.deepEqual(getInventory(sender), ['Empty Water Bottle']);
  assert.deepEqual(getInventory(recipient), []);
  assert.equal(notifications.at(-1).steamID64, sender);
  assert.match(notifications.at(-1).message, /YOUR OFFER WAS DECLINED/);
});
