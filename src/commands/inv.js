const { getInventoryStore } = require('../inventory-store');
const INVENTORY = getInventoryStore()
const { getCurrentInteraction } = require('../interactions');
const { pre, quote } = require('../chat-format');
const {
    configureSteamClient,
    normalizeFriendName,
    personaNameFor,
    resolveFriendsByName,
} = require('../steam-friends');
const pendingFriendSelections = new Map()

function friendSelectionMessage(candidates, prefix = '') {
    return pre([
        prefix || '🔎 I found more than one matching Steam friend:',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ...candidates.map(
            (candidate, index) => `${index + 1}. 👤 ${candidate.name}`
        ),
        '',
        '🔢 Reply with the matching number or full name.',
        '🛑 Reply "cancel" to stop.',
    ])
}

function getInventory(steamId) {
    return [...(INVENTORY.get(String(steamId)) ?? [])]
}

function setInventory(steamId, items=[]) {
    INVENTORY.set(String(steamId), [...items])
}

function addInventoryItem(steamId, item) {
    INVENTORY.add(steamId, item)
}

function getReservations(steamId) {
    return INVENTORY.getReservations(steamId)
}

function getAvailableInventory(steamId) {
    return INVENTORY.getAvailable(steamId)
}

function reserveInventoryItem(steamId, requestedItem, offerId) {
    return INVENTORY.reserve(steamId, requestedItem, offerId)
}

function releaseInventoryReservation(offerId) {
    return INVENTORY.releaseReservation(offerId)
}

function transferReservedInventoryItem(offerId, toSteamId) {
    return INVENTORY.transferReserved(offerId, toSteamId)
}

function clearInventoryReservations() {
    INVENTORY.clearReservations()
}

function transferInventoryItem(fromSteamId, toSteamId, requestedItem) {
    return INVENTORY.transfer(fromSteamId, toSteamId, requestedItem)
}

function updateInventory(steamId, item=[], alreadyExists=false) {
    /**Função para criar/atualizar um inventário
     * Se não houver inventário para o usuário, é criado um.
     * Para atualizar o inventário, deve-se indicar que o inv já existe
     * 
     * @param {string} steamID - SteamId64 do usuário
     * @param {array|string} item - itens (vazio na inicialização) ou item a ser adicionado 
     * @param {boolean} alreadyExists - Este usuário já tem um inventário? 
     * @returns {void} - A função apenas atualiza os inventários, não há retornos.
     */
    if (alreadyExists) {
        addInventoryItem(steamId, item)
        return
     }
    setInventory(steamId, item)
    console.log(`Inventário atualizado para o usuário ${steamId}`)
    console.log(INVENTORY.get(steamId))
}


function spyInventory(steamId, isSelf=false, ownerName='') {
    var inv = INVENTORY.get(steamId)
    const returnType = getCurrentInteraction()?.metadata?.returnType;

    if (returnType === 'raw') {
        return inv ? [...inv] : [];
    }

    if (returnType === 'available') {
        return getAvailableInventory(steamId);
    }

    const title = isSelf
        ? '🎒 YOUR INVENTORY'
        : `🔎 ${ownerName ? `${ownerName.toUpperCase()}’S ` : ''}INVENTORY`;
    if (inv != undefined) {
        const remainingReservations = getReservations(steamId)
        let displayedPendingCount = 0
        const itemLines = inv.map((item, index) => {
          const reservationIndex = remainingReservations.findIndex(
            reservation => reservation.item.toLowerCase() === item.toLowerCase()
          )

          if (reservationIndex !== -1) {
            remainingReservations.splice(reservationIndex, 1)
            displayedPendingCount += 1
            return `${index + 1}. 🔒 ${item} — pending offer`
          }

          return `${index + 1}. 📦 ${item} — available`
        })
        const pendingCount = displayedPendingCount
        const availableCount = inv.length - pendingCount

        return pre([
          `${title} ❄️`,
          '━━━━━━━━━━━━━━━━━━━━',
          ...itemLines,
          '',
          `✅ Available: ${availableCount}`,
          `🔒 Pending offers: ${pendingCount}`,
        ]);
    } else {
        return quote(
          ownerName
            ? `📭 ${ownerName}’s inventory is empty—nothing but cold air here. ❄️`
            : '📭 This inventory is empty—nothing but cold air here. ❄️'
        )
    }
}

async function continueFriendSelection(text, requesterSteamId) {
    const requesterKey = String(requesterSteamId)
    const pending = pendingFriendSelections.get(requesterKey)
    if (!pending) {
        return null
    }

    const response = String(text).trim()
    if (normalizeFriendName(response) === 'cancel') {
        pendingFriendSelections.delete(requesterKey)
        return quote('🛑 Inventory lookup cancelled. ❄️')
    }

    let selected = null
    if (/^\d+$/.test(response)) {
        selected = pending.candidates[Number(response) - 1] ?? null
    } else {
        const matches = pending.candidates.filter(
            candidate => normalizeFriendName(candidate.name) === normalizeFriendName(response)
        )
        selected = matches.length === 1 ? matches[0] : null
    }

    if (!selected) {
        return friendSelectionMessage(
            pending.candidates,
            '🧩 That did not identify one friend. Choose from this list:',
        )
    }

    pendingFriendSelections.delete(requesterKey)
    return spyInventory(selected.steamID64, false, selected.name)
}

module.exports = {
  name: 'inventory',
  aliases: ['i','inv','inventario'],
  args: ['[friend name]'],
  description: 'See your inventory or another Steam friend\'s inventory, including pending-offer locks.',
  async run() {
    const args = Array.from(arguments)
    const requesterSteamId = String(args.at(-1) ?? '')
    const friendQuery = args.slice(1, -1).join(' ').trim()

    if (!friendQuery) {
      return spyInventory(requesterSteamId, true)
    }

    if (/^\d{17}$/.test(friendQuery)) {
      const ownerName = personaNameFor(friendQuery)
      return spyInventory(friendQuery, false, ownerName)
    }

    const candidates = await resolveFriendsByName(friendQuery, requesterSteamId)
    if (candidates.length === 0) {
      return quote([
        `🔍 I could not find a Steam friend matching “${friendQuery}”.`,
        '💡 Use their current persona name and try again.',
      ])
    }

    if (candidates.length > 1) {
      pendingFriendSelections.set(requesterSteamId, { candidates })
      return friendSelectionMessage(candidates)
    }

    return spyInventory(candidates[0].steamID64, false, candidates[0].name)
  },
  configureSteamClient,
  continue: continueFriendSelection,
  hasPending(steamId) {
    return pendingFriendSelections.has(String(steamId))
  },
  updateInventory,
  spyInventory,
  addInventoryItem,
  clearInventoryReservations,
  getAvailableInventory,
  getInventory,
  getReservations,
  releaseInventoryReservation,
  reserveInventoryItem,
  setInventory,
  transferInventoryItem,
  transferReservedInventoryItem,
  _test: {
    pendingFriendSelections,
    resolveFriendsByName,
  }
}
