const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// rooms[code] = { players: [], gs: null, started: false }
// player = { id, name, ready, character, isHost }
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanPlayer(p) {
  // Never send character data of other players to clients (privacy in lobby)
  return { id: p.id, name: p.name, ready: p.ready, isHost: p.isHost, hasCharacter: !!p.character };
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName  = null;
  let playerIdx   = null;

  // ── Room creation ──────────────────────────────────────────────────────────
  socket.on('createRoom', ({ name }) => {
    const code = generateCode();
    rooms[code] = {
      players: [{ id: socket.id, name, ready: false, character: null, isHost: true }],
      gs: null,
      started: false
    };
    currentRoom = code;
    playerName  = name;
    playerIdx   = 0;
    socket.join(code);
    socket.emit('roomCreated', { code, playerIdx: 0 });
    io.to(code).emit('lobbyUpdate', rooms[code].players.map(cleanPlayer));
  });

  // ── Room joining ───────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room)          { socket.emit('joinError', 'Room not found.');      return; }
    if (room.started)   { socket.emit('joinError', 'Game already started.'); return; }
    if (room.players.length >= 4) { socket.emit('joinError', 'Room is full.'); return; }

    playerIdx = room.players.length;
    room.players.push({ id: socket.id, name, ready: false, character: null, isHost: false });
    currentRoom = code;
    playerName  = name;
    socket.join(code);
    socket.emit('joinedRoom', { code, playerIdx });
    io.to(code).emit('lobbyUpdate', room.players.map(cleanPlayer));
  });

  // ── Ready toggle (character is bundled with ready state) ──────────────────
  socket.on('setReady', ({ ready, character }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    room.players[playerIdx].ready = ready;
    if (ready && character) room.players[playerIdx].character = character;
    if (!ready) room.players[playerIdx].character = null;
    io.to(currentRoom).emit('lobbyUpdate', room.players.map(cleanPlayer));
  });

  // ── Launch game (host only, all must be ready) ─────────────────────────────
  socket.on('launchGame', () => {
    const room = rooms[currentRoom];
    if (!room)                              { socket.emit('launchError', 'Room not found.');         return; }
    if (!room.players[playerIdx]?.isHost)   { socket.emit('launchError', 'Only the host can launch.'); return; }
    const notReady = room.players.filter(p => !p.ready).map(p => p.name);
    if (notReady.length > 0)               { socket.emit('launchError', `Not ready: ${notReady.join(', ')}`); return; }

    room.started = true;
    room.initRolls = {};
    io.to(currentRoom).emit('gameStarted', {
      characters: room.players.map(p => p.character || { name: p.name }),
      hostIdx: 0
    });
  });

  // ── Initiative (each player rolls their own die) ────────────────────────────
  socket.on('submitInit', ({ roll, dex }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (!room.initRolls) room.initRolls = {};
    room.initRolls[playerIdx] = { roll, dex, score: roll + dex, playerIdx };

    if (Object.keys(room.initRolls).length === room.players.length) {
      const sorted = Object.values(room.initRolls).sort((a, b) => b.score - a.score);
      const initOrder = sorted.map(r => r.playerIdx);
      io.to(currentRoom).emit('initOrderResult', { initOrder, rolls: sorted });
      room.initRolls = {};
    }
  });

  // ── Game state sync (active player broadcasts after each action) ───────────
  socket.on('syncGameState', (gs) => {
    const room = rooms[currentRoom];
    if (!room) return;
    room.gs = gs;
    socket.to(currentRoom).emit('gameStateUpdate', gs);
  });

  // ── Trade ──────────────────────────────────────────────────────────────────
  socket.on('tradeOffer', (offer) => {
    if (!currentRoom) return;
    // Broadcast offer to the target player (everyone gets it, client filters)
    io.to(currentRoom).emit('tradeOffer', { ...offer, fromIdx: playerIdx });
  });

  socket.on('tradeResponse', (response) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('tradeResponse', { ...response, fromIdx: playerIdx });
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on('chatMessage', ({ text }) => {
    if (!currentRoom || !text || !text.trim()) return;
    io.to(currentRoom).emit('chatMessage', {
      name: playerName,
      text: text.trim(),
      time: Date.now()
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = rooms[currentRoom];
    if (!room) return;

    const name = playerName;
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[currentRoom];
    } else {
      // If host left, assign host to next player
      if (!room.players.some(p => p.isHost)) {
        room.players[0].isHost = true;
      }
      io.to(currentRoom).emit('lobbyUpdate', room.players.map(cleanPlayer));
      io.to(currentRoom).emit('playerDisconnected', { name });
    }
  });
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chronicles server running on port ${PORT}`));
