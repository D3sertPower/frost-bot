'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createInventoryStore(filename = process.env.INVENTORY_DB_PATH ||
  path.join(__dirname, '..', 'data', 'inventory.sqlite')) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }

  const db = new Database(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventories (
      steam_id TEXT PRIMARY KEY NOT NULL,
      items TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      offer_id TEXT PRIMARY KEY NOT NULL,
      steam_id TEXT NOT NULL,
      item TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reservations_by_owner
      ON inventory_reservations (steam_id);
    CREATE TABLE IF NOT EXISTS internal_offers (
      offer_id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL
    );
  `);

  const select = db.prepare('SELECT items FROM inventories WHERE steam_id = ?');
  const upsert = db.prepare(`
    INSERT INTO inventories (steam_id, items) VALUES (?, ?)
    ON CONFLICT(steam_id) DO UPDATE SET items = excluded.items
  `);

  function get(steamId) {
    const row = select.get(String(steamId));
    return row ? JSON.parse(row.items) : undefined;
  }

  function set(steamId, items = []) {
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
      throw new TypeError('Inventory items must be an array of strings.');
    }
    upsert.run(String(steamId), JSON.stringify(items));
  }

  const add = db.transaction((steamId, item) => {
    const items = get(steamId) ?? [];
    items.push(item);
    set(steamId, items);
  });

  // Both inventories commit together; a failed write leaves ownership unchanged.
  const transfer = db.transaction((fromSteamId, toSteamId, requestedItem) => {
    const source = get(fromSteamId) ?? [];
    const normalizedItem = String(requestedItem).trim().toLowerCase();
    const index = source.findIndex(item => item.toLowerCase() === normalizedItem);
    if (index === -1) {
      return false;
    }
    if (String(fromSteamId) === String(toSteamId)) {
      return true;
    }

    const [item] = source.splice(index, 1);
    const target = get(toSteamId) ?? [];
    target.push(item);
    set(fromSteamId, source);
    set(toSteamId, target);
    return true;
  });

  const selectReservations = db.prepare(`
    SELECT offer_id AS offerId, steam_id AS steamId, item
    FROM inventory_reservations WHERE steam_id = ? ORDER BY rowid
  `);
  const selectReservation = db.prepare(`
    SELECT steam_id AS steamId, item FROM inventory_reservations WHERE offer_id = ?
  `);
  const insertReservation = db.prepare('INSERT INTO inventory_reservations VALUES (?, ?, ?)');
  const deleteReservation = db.prepare('DELETE FROM inventory_reservations WHERE offer_id = ?');
  const selectOffer = db.prepare('SELECT data FROM internal_offers WHERE offer_id = ?');
  const insertOffer = db.prepare('INSERT INTO internal_offers VALUES (?, ?)');
  const updateOffer = db.prepare('UPDATE internal_offers SET data = ? WHERE offer_id = ?');

  function getReservations(steamId) {
    return selectReservations.all(String(steamId));
  }

  function getAvailable(steamId) {
    const available = get(steamId) ?? [];
    for (const reservation of getReservations(steamId)) {
      const index = available.findIndex(item => item.toLowerCase() === reservation.item.toLowerCase());
      if (index !== -1) available.splice(index, 1);
    }
    return available;
  }

  const reserve = db.transaction((steamId, requestedItem, offerId) => {
    const normalizedItem = String(requestedItem).trim().toLowerCase();
    const item = getAvailable(steamId).find(item => item.toLowerCase() === normalizedItem);
    if (!item) return null;
    insertReservation.run(String(offerId), String(steamId), item);
    return item;
  });

  function releaseReservation(offerId) {
    return deleteReservation.run(String(offerId)).changes > 0;
  }

  const transferReserved = db.transaction((offerId, toSteamId) => {
    const reservation = selectReservation.get(String(offerId));
    if (!reservation || !transfer(reservation.steamId, toSteamId, reservation.item)) {
      return false;
    }
    releaseReservation(offerId);
    return true;
  });

  function readOffer(row) {
    if (!row) return null;
    const offer = JSON.parse(row.data);
    offer.created_at = new Date(offer.created_at);
    offer.decided_at = offer.decided_at ? new Date(offer.decided_at) : null;
    return offer;
  }

  // Creating an offer and locking its item are a single durable operation.
  const createOffer = db.transaction(offer => {
    const item = reserve(offer.offeror_sid, offer.item, offer.transaction_id);
    if (!item) return null;
    const saved = { ...offer, item };
    insertOffer.run(String(offer.transaction_id), JSON.stringify(saved));
    return saved;
  });

  // Persist the decision with ownership and lock changes to prevent replay after a crash.
  const decideOffer = db.transaction((offerId, recipient, action) => {
    if (action !== 'accepted' && action !== 'declined') {
      throw new TypeError('Offer action must be accepted or declined.');
    }
    const offer = readOffer(selectOffer.get(String(offerId)));
    if (!offer) return { code: 'not_found' };
    if (offer.offeree_sid !== String(recipient)) return { code: 'forbidden', offer };
    if (offer.status !== 'pending') return { code: 'already_decided', offer };
    if (action === 'accepted' && !transferReserved(offerId, recipient)) {
      return { code: 'missing_item', offer };
    }
    if (action === 'declined') releaseReservation(offerId);
    offer.status = action;
    offer.decided_at = new Date();
    updateOffer.run(JSON.stringify(offer), String(offerId));
    return { code: 'decided', offer };
  });

  function clearReservations() {
    db.exec('DELETE FROM inventory_reservations');
  }

  const clearOffers = db.transaction(() => {
    db.exec('DELETE FROM internal_offers');
    clearReservations();
  });

  return {
    get,
    set,
    add: add.immediate,
    transfer: transfer.immediate,
    getReservations,
    getAvailable,
    reserve: reserve.immediate,
    releaseReservation,
    transferReserved: transferReserved.immediate,
    clearReservations,
    createOffer: createOffer.immediate,
    decideOffer: decideOffer.immediate,
    getOffers: () => db.prepare('SELECT data FROM internal_offers ORDER BY rowid').all().map(readOffer),
    clearOffers: clearOffers.immediate,
    close: () => db.close(),
  };
}

let inventoryStore;
function getInventoryStore() {
  inventoryStore ??= createInventoryStore();
  return inventoryStore;
}

module.exports = { createInventoryStore, getInventoryStore };
