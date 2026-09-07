'use strict';

require('dotenv').config({ quiet: true });

const path = require('node:path');
const SteamUser = require('steam-user');
const TradeOfferManager = require('steam-tradeoffer-manager')

const { quote } = require('./chat-format');
const { getReply, COMMANDS } = require('./message-handler');
const { MANAGER_MODE_USERS } = require('./commands/manage')
const { addInventoryItem } = require('./commands/inv')

const {
  configureSteamClient: configureInventory,
  updateInventory,
} = require('./commands/inv')
const { configureSteamClient: configureDeposit } = require('./commands/deposit');
const { configureSteamClient: configureSendOffer } = require('./commands/sendoffer');
const { STEAM_ACCOUNT_NAME, STEAM_PASSWORD } = process.env;

if (!STEAM_ACCOUNT_NAME || !STEAM_PASSWORD) {
  console.error(
    'Configure STEAM_ACCOUNT_NAME e STEAM_PASSWORD no arquivo .env antes de iniciar.',
  );
  process.exit(1);
}

const client = new SteamUser({
  autoRelogin: true,
  dataDirectory: path.join(__dirname, '..', 'data'),
});

const manager = new TradeOfferManager({
  steam: client,
  pollInterval: -1
});

client.on('tradeRequest', async (steamID) => {
  await client.chat.sendFriendMessage(
          steamID,
          quote([
            '✨ I have received your trade offer!'
          ]),
        );
  if (MANAGER_MODE_USERS.includes(steamID)) {
    await client.chat.sendFriendMessage(
          steamID,
          pre([
            '🔧 I have accepted your trade offer, manager.',
            '📰 Reminder: No items are stored in your deposit.'
          ]),
        );
    respond(true)
  }
  else {
  manager.doPoll()
  }
});

manager.on('newOffer', (offer) => {
  console.log(`Received offer #${offer.id} from ${offer.partner.getSteamID64()}`);

  if (offer.itemsToGive.length === 0) {
    console.log(`Offer #${offer.id} requests 0 items from us. Accepting...`);
    var items = offer.itemsToReceive
    offer.accept((err, status) => {
      if (err) {
        console.error(`Failed to accept offer #${offer.id}:`, err);
        return;
      }
      for (var item of items) {
      addInventoryItem(offer.partner.getSteamID64(), item.name)
      }
      console.log(`Offer #${offer.id} successfully accepted! Status: ${status}`);
    });
  } else {
    console.log(`Offer #${offer.id} asks for ${offer.itemsToGive.length} items. Ignoring.`);
  }
});

configureDeposit(client, { manager });
configureInventory(client);
configureSendOffer(client);

client.on('loggedOn', () => {
  console.log(`Conectado à Steam como ${client.steamID.getSteamID64()}.`);
  client.setPersona(SteamUser.EPersonaState.Online);
  client.gamesPlayed('🍷 How may FructoseIQ help you today? 🥑');
});

client.on('friendRelationship',
  async (steamID, relationship, previousRelationship) => {
    try {
      if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
        console.log(`Pedido recebido de ${steamID.getSteamID64()}`);

        await client.addFriend(steamID);
        return;
      }

      if (
        relationship === SteamUser.EFriendRelationship.Friend &&
        previousRelationship === SteamUser.EFriendRelationship.RequestRecipient
      ) {
        await client.chat.sendFriendMessage(
          steamID,
          quote([
            '👋 Welcome aboard the FrostBoat! ⛵',
            '🧭 Send !help to open the full command deck.',
            '🛡️ Trade smart, stay safe, and keep it frosty.',
          ]),
        );

        console.log(`Mensagem de boas-vindas enviada para ${steamID.getSteamID64()}`);
      }
    } catch (error) {
      console.error(
        `Não foi possível aceitar ou responder ${steamID.getSteamID64()}:`,
        error.message
      );
    }
  }
);

client.chat.on('friendMessage', async (incoming) => { // incoming é o evento
  const friendId = incoming.steamid_friend;
  const friendId64 = friendId.getSteamID64();

  // A Steam recomenda confirmar cada mensagem recebida para não acumular
  // notificações não lidas na conta do bot.
  client.chat.ackFriendMessage(friendId, incoming.server_timestamp);

  const reply = await getReply(
    incoming.message_no_bbcode ?? incoming.message,
    friendId64,
  );
  // tentamos pegar a mensagem sem formatação se não for possível
  // pegamos a mensagem com formatação mesmo
  if (!reply) {
    return;
  } 
  // getReply está no message-handler.js

  // este bloco de código só executa se um comando for detectado
  console.log(`Comando ${incoming.message_no_bbcode} recebido de ${friendId64}.`);

  try {
    await client.chat.sendFriendMessage(friendId, reply);
    console.log(`Resposta enviada para ${friendId64}.`);
  } catch (error) {
    console.error(`Falha ao responder ${friendId64}:`, error.message);
  }
});

client.on('disconnected', (eresult, message) => {
  const reason = SteamUser.EResult[eresult] ?? eresult;
  console.warn(`Desconectado da Steam (${reason})${message ? `: ${message}` : ''}.`);
});

client.on('error', (error) => {
  const result = error.eresult
    ? ` (${SteamUser.EResult[error.eresult] ?? error.eresult})`
    : '';
  console.error(`Erro da Steam${result}:`, error.message);
});

function shutdown(signal) {
  console.log(`Recebido ${signal}; encerrando.`);
  client.logOff();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

client.logOn({
  accountName: STEAM_ACCOUNT_NAME,
  password: STEAM_PASSWORD,
  machineName: 'frostBot',
});
