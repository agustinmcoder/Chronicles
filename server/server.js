const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// rooms[code] = { players: [], gs: null, started: false, voiceParticipants: Set, _disconnectTimers: {} }
// player = { id, name, ready, character, isHost, disconnected }
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanPlayer(p) {
  return { id: p.id, name: p.name, ready: p.ready, isHost: p.isHost,
           hasCharacter: !!p.character, disconnected: !!p.disconnected };
}

function connectedCount(room) {
  return room.players.filter(p => !p.disconnected).length;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName  = null;
  let playerIdx   = null;

  // ── Room creation ──────────────────────────────────────────────────────────
  socket.on('createRoom', ({ name }) => {
    const code = generateCode();
    rooms[code] = {
      players: [{ id: socket.id, name, ready: false, character: null, isHost: true, disconnected: false }],
      gs: null, started: false, initRolls: {},
      voiceParticipants: new Set(), _disconnectTimers: {}
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
    if (!room)               { socket.emit('joinError', 'Room not found.');      return; }
    if (room.started)        { socket.emit('joinError', 'Game already started.'); return; }
    if (room.players.length >= 4) { socket.emit('joinError', 'Room is full.'); return; }

    playerIdx = room.players.length;
    room.players.push({ id: socket.id, name, ready: false, character: null, isHost: false, disconnected: false });
    currentRoom = code;
    playerName  = name;
    socket.join(code);
    socket.emit('joinedRoom', { code, playerIdx, lang: room.lang || 'en' });
    io.to(code).emit('lobbyUpdate', room.players.map(cleanPlayer));
  });

  // ── Reconnection (mid-game) ────────────────────────────────────────────────
  socket.on('rejoinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room || !room.started) { socket.emit('joinError', 'Room not found or not in progress.'); return; }

    const idx = room.players.findIndex(p => p.name === name && p.disconnected);
    if (idx === -1) { socket.emit('joinError', 'No disconnected slot found for that name.'); return; }

    // Cancel the removal timer
    clearTimeout(room._disconnectTimers[idx]);
    delete room._disconnectTimers[idx];

    // Restore slot
    room.players[idx].disconnected = false;
    room.players[idx].id = socket.id;
    currentRoom = code;
    playerName  = name;
    playerIdx   = idx;
    socket.join(code);

    // Send full current state so they can resume
    socket.emit('rejoinedRoom', { code, playerIdx: idx, gs: room.gs });
    io.to(code).emit('playerReconnected', { name });
    io.to(code).emit('lobbyUpdate', room.players.map(cleanPlayer));

    // Restore voice if they were in it
    if (room.voiceParticipants.has(idx)) {
      socket.emit('voiceUpdate', { participants: [...room.voiceParticipants] });
    }
  });

  // ── Ready toggle ──────────────────────────────────────────────────────────
  socket.on('setReady', ({ ready, character }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    room.players[playerIdx].ready = ready;
    if (ready && character) room.players[playerIdx].character = character;
    if (!ready) room.players[playerIdx].character = null;
    io.to(currentRoom).emit('lobbyUpdate', room.players.map(cleanPlayer));
  });

  // ── Launch game ────────────────────────────────────────────────────────────
  socket.on('launchGame', () => {
    const room = rooms[currentRoom];
    if (!room)                              { socket.emit('launchError', 'Room not found.');          return; }
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

  // ── Initiative ─────────────────────────────────────────────────────────────
  socket.on('submitInit', ({ roll, dex }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (!room.initRolls) room.initRolls = {};
    room.initRolls[playerIdx] = { roll, dex, score: roll + dex, playerIdx };

    // Fire when all *connected* players have rolled
    if (Object.keys(room.initRolls).length === connectedCount(room)) {
      const sorted = Object.values(room.initRolls).sort((a, b) => b.score - a.score);
      io.to(currentRoom).emit('initOrderResult', { initOrder: sorted.map(r => r.playerIdx), rolls: sorted });
      room.initRolls = {};
    }
  });

  // ── Game state sync ────────────────────────────────────────────────────────
  socket.on('syncGameState', (gs) => {
    const room = rooms[currentRoom];
    if (!room) return;
    room.gs = gs;
    socket.to(currentRoom).emit('gameStateUpdate', gs);
  });

  // ── Trade ──────────────────────────────────────────────────────────────────
  socket.on('tradeOffer', (offer) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('tradeOffer', { ...offer, fromIdx: playerIdx });
  });

  socket.on('tradeResponse', (response) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('tradeResponse', { ...response, fromIdx: playerIdx });
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on('chatMessage', ({ text }) => {
    if (!currentRoom || !text?.trim()) return;
    io.to(currentRoom).emit('chatMessage', { name: playerName, text: text.trim(), time: Date.now() });
  });

  // ── Spectator chat (battle screen — routed only to non-active players) ─────
  socket.on('spectatorChat', ({ text }) => {
    if (!currentRoom || !text?.trim()) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const activeIdx = room.gs?.gs?.curP ?? -1;
    room.players.forEach((p, i) => {
      if (p.id && !p.disconnected && i !== activeIdx) {
        io.to(p.id).emit('spectatorChat', { name: playerName, text: text.trim(), time: Date.now() });
      }
    });
  });

  // ── Voice chat signaling ───────────────────────────────────────────────────
  socket.on('joinVoice', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (!room.voiceParticipants) room.voiceParticipants = new Set();
    const existing = [...room.voiceParticipants];
    room.voiceParticipants.add(playerIdx);
    // Tell new joiner who is already in voice
    if (existing.length > 0) socket.emit('voiceExistingPeers', { peers: existing });
    // Tell existing peers a new person joined (they initiate the offer)
    existing.forEach(i => {
      const p = room.players[i];
      if (p?.id) io.to(p.id).emit('voicePeerJoined', { fromIdx: playerIdx });
    });
    io.to(currentRoom).emit('voiceUpdate', { participants: [...room.voiceParticipants] });
  });

  socket.on('leaveVoice', () => {
    const room = rooms[currentRoom];
    if (!room?.voiceParticipants) return;
    room.voiceParticipants.delete(playerIdx);
    io.to(currentRoom).emit('voiceUpdate', { participants: [...room.voiceParticipants] });
    io.to(currentRoom).emit('voicePeerLeft', { fromIdx: playerIdx });
  });

  socket.on('voiceOffer', ({ targetIdx, offer }) => {
    const room = rooms[currentRoom];
    const target = room?.players[targetIdx];
    if (target?.id) io.to(target.id).emit('voiceOffer', { fromIdx: playerIdx, offer });
  });

  socket.on('voiceAnswer', ({ targetIdx, answer }) => {
    const room = rooms[currentRoom];
    const target = room?.players[targetIdx];
    if (target?.id) io.to(target.id).emit('voiceAnswer', { fromIdx: playerIdx, answer });
  });

  socket.on('voiceIce', ({ targetIdx, candidate }) => {
    const room = rooms[currentRoom];
    const target = room?.players[targetIdx];
    if (target?.id) io.to(target.id).emit('voiceIce', { fromIdx: playerIdx, candidate });
  });

  // ── Language ───────────────────────────────────────────────────────────────
  socket.on('setLang', ({ lang }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (playerIdx !== 0) return; // only host
    room.lang = lang;
    socket.to(currentRoom).emit('setLang', { lang });
  });

  // ── Ping ───────────────────────────────────────────────────────────────────
  socket.on('_ping', (ts) => socket.emit('_pong', ts));

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    const name = playerName;

    // Remove from voice
    if (room.voiceParticipants) {
      room.voiceParticipants.delete(playerIdx);
      io.to(currentRoom).emit('voiceUpdate', { participants: [...room.voiceParticipants] });
      io.to(currentRoom).emit('voicePeerLeft', { fromIdx: playerIdx });
    }

    if (room.started && playerIdx !== null) {
      // Mid-game: mark disconnected, give 90s to reconnect
      room.players[playerIdx].disconnected = true;
      room.players[playerIdx].id = null;
      io.to(currentRoom).emit('playerDisconnected', { name, idx: playerIdx, reconnectable: true });
      io.to(currentRoom).emit('lobbyUpdate', room.players.map(cleanPlayer));

      room._disconnectTimers[playerIdx] = setTimeout(() => {
        // Permanent removal after timeout
        const p = room.players[playerIdx];
        if (!p || !p.disconnected) return; // already reconnected
        room.players[playerIdx] = null; // null-out the slot
        const remaining = room.players.filter(Boolean);
        if (remaining.length === 0) { delete rooms[currentRoom]; return; }
        // Host migration
        const hadHost = remaining.some(p => p.isHost);
        if (!hadHost) {
          remaining[0].isHost = true;
          const newHostIdx = room.players.indexOf(remaining[0]);
          io.to(remaining[0].id).emit('becomeHost');
          io.to(currentRoom).emit('hostMigrated', { name: remaining[0].name });
        }
        io.to(currentRoom).emit('playerLeft', { name });
      }, 90000);
    } else {
      // Lobby: remove immediately
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { delete rooms[currentRoom]; return; }
      if (!room.players.some(p => p.isHost)) {
        room.players[0].isHost = true;
        io.to(room.players[0].id).emit('becomeHost');
        io.to(currentRoom).emit('hostMigrated', { name: room.players[0].name });
      }
      io.to(currentRoom).emit('lobbyUpdate', room.players.map(cleanPlayer));
      io.to(currentRoom).emit('playerDisconnected', { name });
    }
  });
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chronicles server running on port ${PORT}`));
