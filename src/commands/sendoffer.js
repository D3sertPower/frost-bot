'use strict';

const { randomUUID: uuidv4 } = require('node:crypto');
const { callInteraction } = require('../interactions');
const { code, pre, quote } = require('../chat-format');
const {
  configureSteamClient: configureSteamFriends,
  normalizeFriendName,
  personaNameFor,
  profileMatches,
  resolveLeadingFriend,
} = require('../steam-friends');
const { getInventoryStore } = require('../inventory-store');
const inventoryStore = getInventoryStore();

const ACTIVE_OFFERS = new Map(
  inventoryStore.getOffers().map(offer => [offer.transaction_id, offer]),
);
const ACCEPT_ALIASES = new Set(['accept', 'acceptoffer', 'aceitar']);
const DECLINE_ALIASES = new Set(['decline', 'declineoffer', 'recusar']);
const LIST_ALIASES = new Set(['offers', 'myoffers', 'ofertas']);
const pendingRecipientSelections = new Map();
const pendingOfferDecisions = new Map();

let steamClient = null;

class Offer {
  constructor(transactionId, item, offeror, offeree, offerorName, offereeName) {
    this.transaction_id = transactionId;
    this.item = item;
    this.offeror_sid = offeror;
    this.offeree_sid = offeree;
    this.offeror_name = offerorName;
    this.offeree_name = offereeName;
    this.status = 'pending';
    this.created_at = new Date();
    this.decided_at = null;
  }
}

function configureSteamClient(client) {
  if (!client?.chat || typeof client.chat.sendFriendMessage !== 'function') {
    throw new TypeError('A Steam client with chat support is required.');
  }

  steamClient = client;
  configureSteamFriends(client);
}

async function sendUserMessage(steamID64, message) {
  if (!steamClient) {
    return false;
  }

  try {
    await steamClient.chat.sendFriendMessage(steamID64, message);
    return true;
  } catch (error) {
    console.warn(`Could not notify Steam user ${steamID64}: ${error.message}`);
    return false;
  }
}

function recipientSelectionMessage(candidates, requestedItem, prefix = '') {
  return pre([
    prefix || '🧭 I found more than one friend with that name:',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...candidates.map(
      (candidate, index) => `${index + 1}. 👤 ${candidate.name}`,
    ),
    '',
    `📦 Item: ${requestedItem}`,
    '🔢 Reply with the matching number or full name.',
    '🛑 Reply "cancel" to stop.',
  ]);
}

function pendingOffersFor(steamID64) {
  return Array.from(ACTIVE_OFFERS.values()).filter(
    (offer) =>
      offer.offeree_sid === steamID64 && offer.status === 'pending',
  );
}

function offerListMessage(
  offers,
  heading = '📨 YOUR PENDING OFFERS',
  instructions = ['🔢 Reply with an offer index to select it.'],
) {
  return pre([
    heading,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...offers.flatMap((offer, index) => [
      `${index + 1}. 📦 ${offer.item}`,
      `   📤 From: ${offer.offeror_name}`,
    ]),
    '',
    ...instructions,
    '♾️ These offers do not expire.',
  ]);
}

function receivedOfferMessage(offer) {
  return pre([
    '📨 NEW ITEM OFFER RECEIVED ❄️',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📦 Item: ${offer.item}`,
    `📤 From: ${offer.offeror_name}`,
    '',
    '📋 Send !offers to open your numbered offer list.',
    '✅ Or send !accept, then reply with an index.',
    '❌ Or send !decline, then reply with an index.',
    '♾️ No rush—this offer has no time limit.',
  ]);
}

function senderDecisionMessage(offer) {
  const accepted = offer.status === 'accepted';

  return pre([
    accepted ? '✅ YOUR OFFER WAS ACCEPTED' : '❌ YOUR OFFER WAS DECLINED',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📦 Item: ${offer.item}`,
    `📥 Recipient: ${offer.offeree_name}`,
    `🧾 Offer ID: ${offer.transaction_id}`,
    `${accepted ? '🎉' : '🧊'} Status: ${offer.status}`,
  ]);
}

function resolveOfferForRecipient(offerID, recipient) {
  if (offerID) {
    return {
      offer: ACTIVE_OFFERS.get(offerID) ?? null,
      pending: pendingOffersFor(recipient),
    };
  }

  const pending = pendingOffersFor(recipient);
  return {
    offer: pending.length === 1 ? pending[0] : null,
    pending,
  };
}

async function decideOffer(action, offerID, recipient) {
  const { offer, pending } = resolveOfferForRecipient(offerID, recipient);

  if (!offer) {
    if (!offerID && pending.length > 1) {
      return offerListMessage(
        pending,
        '🧩 CHOOSE WHICH OFFER TO HANDLE',
      );
    }

    return quote([
      '📭 No matching offer was found.',
      '💡 Use !offers to see your pending offers.',
    ]);
  }

  const result = inventoryStore.decideOffer(offer.transaction_id, recipient, action);
  if (result.offer) Object.assign(offer, result.offer);

  if (result.code === 'forbidden') {
    return quote('🔒 Only the intended recipient can accept or decline this offer.');
  }

  if (result.code === 'already_decided') {
    return quote([
      `ℹ️ This offer was already ${offer.status}.`,
      `🧾 Offer ID: ${offer.transaction_id}`,
    ]);
  }

  if (result.code === 'missing_item') {
    return quote([
      '⚠️ The offer is still pending, but the item is no longer in the sender’s inventory.',
      '🧊 Nothing was transferred. Please contact the sender.',
    ]);
  }

  if (result.code === 'not_found') {
    return quote('📭 No matching offer was found.');
  }

  await sendUserMessage(offer.offeror_sid, senderDecisionMessage(offer));

  if (action === 'accepted') {
    return pre([
      '✅ OFFER ACCEPTED—ITEM TRANSFERRED! 🎉',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `📦 Item: ${offer.item}`,
      '🎒 Added to your inventory.',
      `🧾 Offer ID: ${offer.transaction_id}`,
    ]);
  }

  return pre([
    '❌ OFFER DECLINED',
    '━━━━━━━━━━━━━━━━━━',
    `📦 Item: ${offer.item}`,
    '🔒 The item remains with the sender.',
    `🧾 Offer ID: ${offer.transaction_id}`,
  ]);
}

function beginIndexedDecision(recipient, action = null) {
  const offers = pendingOffersFor(recipient);
  if (offers.length === 0) {
    pendingOfferDecisions.delete(recipient);
    return quote('📭 You have no pending item offers right now. ❄️');
  }

  pendingOfferDecisions.set(recipient, {
    action,
    offerIDs: offers.map((offer) => offer.transaction_id),
    selectedOfferID: null,
  });

  const actionLabel = action === 'accepted'
    ? 'ACCEPT'
    : action === 'declined'
      ? 'DECLINE'
      : 'SELECT';

  return offerListMessage(
    offers,
    `${action === 'accepted' ? '✅' : action === 'declined' ? '❌' : '📨'} CHOOSE AN OFFER TO ${actionLabel}`,
    [
      `🔢 Reply with the offer index to ${actionLabel.toLowerCase()} it.`,
      '🛑 Reply "cancel" to stop.',
    ],
  );
}

function selectedOfferDecisionMessage(offer) {
  return pre([
    '🧭 OFFER SELECTED',
    '━━━━━━━━━━━━━━━━━━',
    `📦 Item: ${offer.item}`,
    `📤 From: ${offer.offeror_name}`,
    '',
    '✅ Reply "accept" to receive it.',
    '❌ Reply "decline" to refuse it.',
    '🛑 Reply "cancel" to stop.',
  ]);
}

async function continueOfferDecision(text, recipient) {
  const pending = pendingOfferDecisions.get(recipient);
  if (!pending) {
    return null;
  }

  const response = normalizeFriendName(text);
  if (response === 'cancel') {
    pendingOfferDecisions.delete(recipient);
    return quote('🛑 Offer selection cancelled. Nothing was changed. ❄️');
  }

  if (pending.selectedOfferID) {
    if (response !== 'accept' && response !== 'decline') {
      const selectedOffer = ACTIVE_OFFERS.get(pending.selectedOfferID);
      return selectedOffer
        ? selectedOfferDecisionMessage(selectedOffer)
        : beginIndexedDecision(recipient);
    }

    pendingOfferDecisions.delete(recipient);
    return decideOffer(
      response === 'accept' ? 'accepted' : 'declined',
      pending.selectedOfferID,
      recipient,
    );
  }

  const selectedIndex = /^\d+$/.test(response) ? Number(response) - 1 : -1;
  const offerID = pending.offerIDs[selectedIndex];
  const offer = offerID ? ACTIVE_OFFERS.get(offerID) : null;

  if (!offer || offer.status !== 'pending' || offer.offeree_sid !== recipient) {
    return beginIndexedDecision(recipient, pending.action);
  }

  if (pending.action) {
    pendingOfferDecisions.delete(recipient);
    return decideOffer(pending.action, offer.transaction_id, recipient);
  }

  pending.selectedOfferID = offer.transaction_id;
  return selectedOfferDecisionMessage(offer);
}

async function createInternalOffer({
  offeror,
  offerorName,
  offeree,
  offereeName,
  requestedItem,
}) {
  if (offeree === offeror) {
    return quote('🪞 You cannot send an offer to yourself. Pick another trader! 🔁');
  }

  const inventoryResult = await callInteraction(
    'inventory',
    ['inventory', offeror],
    {
      mode: 'result',
      metadata: { returnType: 'available' },
    },
  );

  if (!inventoryResult.ok) {
    return quote([
      '❌ I could not open your inventory.',
      `🧩 Error code: ${inventoryResult.code}`,
      '🔄 Please wait a moment and try again.',
    ]);
  }

  const availableInventory = inventoryResult.value;

  if (availableInventory.length === 0) {
    return quote([
      '🔒 You have no items available to offer.',
      '📨 Items already in pending offers stay visible in !inventory, but remain locked.',
    ]);
  }

  const normalizedItem = requestedItem.toLowerCase();
  const item = availableInventory.find(
    (inventoryItem) => inventoryItem.toLowerCase() === normalizedItem,
  );

  if (!item) {
    return pre([
      '🔍 ITEM NOT AVAILABLE ❌',
      '━━━━━━━━━━━━━━━━━━━━━━━━',
      `🧊 Requested: ${requestedItem}`,
      `🎒 Available: ${availableInventory.join(' • ')}`,
      '💡 Pending items are locked until their offer is accepted or declined.',
    ]);
  }

  const transactionId = uuidv4();
  const tradeOffer = inventoryStore.createOffer(new Offer(
    transactionId,
    item,
    offeror,
    offeree,
    offerorName,
    offereeName,
  ));

  if (!tradeOffer) {
    return quote([
      '🔒 That item was reserved by another offer just now.',
      '🔄 Refresh !inventory and choose an available item.',
    ]);
  }

  ACTIVE_OFFERS.set(transactionId, tradeOffer);
  const recipientNotified = await sendUserMessage(
    offeree,
    receivedOfferMessage(tradeOffer),
  );

  return pre([
    '✅ OFFER CREATED SUCCESSFULLY ❄️',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `🧾 Transaction: ${tradeOffer.transaction_id}`,
    `📦 Item: ${tradeOffer.item}`,
    `📤 From: ${tradeOffer.offeror_name}`,
    `📥 To: ${tradeOffer.offeree_name}`,
    `🟢 Status: ${tradeOffer.status}`,
    recipientNotified
      ? '📨 Recipient notified in Steam chat.'
      : '⚠️ Recipient notification could not be delivered.',
    '♾️ This offer has no time limit.',
  ]);
}

async function continueRecipientSelection(text, offeror) {
  const pending = pendingRecipientSelections.get(offeror);
  if (!pending) {
    return null;
  }

  const response = String(text).trim();
  if (normalizeFriendName(response) === 'cancel') {
    pendingRecipientSelections.delete(offeror);
    return quote('🛑 Offer cancelled. The item was never reserved. ❄️');
  }

  let candidate = null;
  if (/^\d+$/.test(response)) {
    candidate = pending.candidates[Number(response) - 1] ?? null;
  } else {
    const matchingCandidates = pending.candidates.filter(
      (profile) => profileMatches(profile, response, true),
    );
    candidate = matchingCandidates.length === 1
      ? matchingCandidates[0]
      : null;
  }

  if (!candidate) {
    return recipientSelectionMessage(
      pending.candidates,
      pending.requestedItem,
      '🧩 That did not identify one friend. Choose from this list:',
    );
  }

  pendingRecipientSelections.delete(offeror);
  return createInternalOffer({
    offeror,
    offerorName: pending.offerorName,
    offeree: candidate.steamID64,
    offereeName: candidate.name,
    requestedItem: pending.requestedItem,
  });
}

async function continueSendOfferInteraction(text, steamID64) {
  if (pendingRecipientSelections.has(steamID64)) {
    return continueRecipientSelection(text, steamID64);
  }

  return continueOfferDecision(text, steamID64);
}

function clearOfferState() {
  inventoryStore.clearOffers();
  ACTIVE_OFFERS.clear();
  pendingOfferDecisions.clear();
  pendingRecipientSelections.clear();
}

module.exports = {
  name: 'sendoffer',
  aliases: [
    's', 'send', 'soffer', 'enviaroferta',
    'accept', 'acceptoffer', 'aceitar',
    'decline', 'declineoffer', 'recusar',
    'offers', 'myoffers', 'ofertas',
  ],
  args: ['<friend name>', '<item name>'],
  description: 'Send, inspect, accept, or decline an internal item offer.',

  async run() {
    const args = Array.from(arguments);
    const invokedAs = String(args[0] ?? '').toLowerCase();
    const actor = String(args.at(-1) ?? '');

    if (LIST_ALIASES.has(invokedAs)) {
      return beginIndexedDecision(actor);
    }

    if (ACCEPT_ALIASES.has(invokedAs) || DECLINE_ALIASES.has(invokedAs)) {
      const offerID = args.slice(1, -1).join(' ').trim();
      const action = ACCEPT_ALIASES.has(invokedAs) ? 'accepted' : 'declined';
      return offerID
        ? decideOffer(action, offerID, actor)
        : beginIndexedDecision(actor, action);
    }

    const offeror = actor;
    const offerTokens = args.slice(1, -1);

    if (offerTokens.length < 2) {
      return code([
        '⚠️ A friend name and item are required.',
        '🧊 Usage: !sendoffer <friend name> <item name>',
        '✨ Example: !sendoffer Alice The Frosty Ban Hammer',
      ]);
    }

    const resolvedRecipient = await resolveLeadingFriend(offerTokens, offeror);
    if (resolvedRecipient.candidates.length === 0) {
      return quote([
        '🔍 I could not find that person in my Steam friends list.',
        '💡 Use their current Steam persona name—no Steam ID is needed.',
      ]);
    }

    const offerorName = personaNameFor(offeror, 'You');
    if (resolvedRecipient.candidates.length > 1) {
      pendingRecipientSelections.set(offeror, {
        candidates: resolvedRecipient.candidates,
        offerorName,
        requestedItem: resolvedRecipient.remainingText,
      });
      return recipientSelectionMessage(
        resolvedRecipient.candidates,
        resolvedRecipient.remainingText,
      );
    }

    const [recipient] = resolvedRecipient.candidates;
    return createInternalOffer({
      offeror,
      offerorName,
      offeree: recipient.steamID64,
      offereeName: recipient.name,
      requestedItem: resolvedRecipient.remainingText,
    });
  },

  ACTIVE_OFFERS,
  Offer,
  configureSteamClient,
  continue: continueSendOfferInteraction,
  hasPending(steamID64) {
    const steamID = String(steamID64);
    return pendingRecipientSelections.has(steamID) ||
      pendingOfferDecisions.has(steamID);
  },
  _test: {
    clearOfferState,
    continueOfferDecision,
    decideOffer,
    pendingOfferDecisions,
    pendingRecipientSelections,
    pendingOffersFor,
    resolveRecipient: resolveLeadingFriend,
  },
};
