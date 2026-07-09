const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8080;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
const clients = new Map(); // ws -> { roomId, playerId }

// Deck generation
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function getRankValue(rank) {
    if (rank === 'J') return 11;
    if (rank === 'Q') return 12;
    if (rank === 'K') return 13;
    if (rank === 'A') return 14;
    return parseInt(rank);
}

function createDeck() {
    let deck = [];
    let id = 0;
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ id: `card_${id++}`, suit, rank, rankValue: getRankValue(rank) });
        }
    }
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (e) {
            console.error('Invalid JSON received:', message, e);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid action' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        handleDisconnect(ws);
    });
});

function broadcast(roomId, messageObj, excludeWs = null) {
    const data = JSON.stringify(messageObj);
    wss.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            const clientInfo = clients.get(client);
            if (clientInfo && clientInfo.roomId === roomId) {
                // Send specific state to each player to hide other players' hands and deck
                if (messageObj.type === 'state') {
                    const personalizedState = JSON.parse(JSON.stringify(messageObj.state));
                    personalizedState.deck = personalizedState.deck.length; // hide deck
                    personalizedState.players.forEach(p => {
                        if (p.id !== clientInfo.playerId) {
                            p.hand = p.hand.length; // hide opponents' hands
                        }
                    });
                    client.send(JSON.stringify({ type: 'state', state: personalizedState }));
                } else {
                    client.send(data);
                }
            }
        }
    });
}

function broadcastState(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        broadcast(roomId, { type: 'state', state: room });
    }
}

function handleMessage(ws, data) {
    if (data.type === 'join') {
        joinRoom(ws, data.roomId, data.playerName);
    } else if (data.type === 'addBot') {
        const clientInfo = clients.get(ws);
        if (clientInfo) joinBot(clientInfo.roomId);
    } else if (data.type === 'ready') {
        const clientInfo = clients.get(ws);
        if (clientInfo) setReady(clientInfo.roomId, clientInfo.playerId);
    } else if (data.type === 'action') {
        const clientInfo = clients.get(ws);
        if (clientInfo) handleAction(clientInfo.roomId, clientInfo.playerId, data);
    } else if (data.type === 'chat') {
        const clientInfo = clients.get(ws);
        if (clientInfo) {
            broadcast(clientInfo.roomId, { type: 'chat', player: getPlayerName(clientInfo.roomId, clientInfo.playerId), message: data.message });
        }
    } else if (data.type === 'leave') {
        handleDisconnect(ws);
    }
}

function getPlayerName(roomId, playerId) {
    const room = rooms.get(roomId);
    if (!room) return 'Unknown';
    const player = room.players.find(p => p.id === playerId);
    return player ? player.name : 'Unknown';
}

function joinRoom(ws, roomId, playerName) {
    let room = rooms.get(roomId);
    if (!room) {
        room = {
            roomId,
            players: [],
            deck: [],
            communityCards: [],
            communityRevealed: [false, false, false, false, false],
            pot: 0,
            currentTurn: null,
            phase: 'waiting', // waiting, betting, attack, defense, showdown, finished
            round: 1,
            mandatoryBet: 2,
            lastAction: null,
            currentBet: 0,
            history: [],
            combat: null // { attacker, defender, attackCard }
        };
        rooms.set(roomId, room);
    }

    let playerId = `p_${Math.random().toString(36).substring(2, 9)}`;

    // Check for reconnect
    let existingPlayer = room.players.find(p => p.name === playerName && p.disconnected);
    if (existingPlayer) {
        playerId = existingPlayer.id;
        existingPlayer.disconnected = false;
    } else {
        room.players.push({
            id: playerId,
            name: playerName,
            chips: 1000,
            hand: [],
            archive: [],
            folded: false,
            disconnected: false,
            isReady: false,
            bet: 0,
            defenses: 0
        });
    }

    clients.set(ws, { roomId, playerId });
    broadcastState(roomId);
}

function setReady(roomId, playerId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) {
        player.isReady = true;
        if (room.players.length >= 2 && room.players.every(p => p.isReady)) {
            startGame(room);
        }
        broadcastState(roomId);
    }
}

function startGame(room) {
    room.deck = createDeck();
    room.communityCards = room.deck.splice(0, 5);
    room.communityRevealed = [false, false, false, false, false];
    room.pot = 0;
    room.currentBet = room.mandatoryBet;
    room.phase = 'betting';
    room.history = [];
    room.combat = null;

    room.players.forEach(p => {
        p.hand = room.deck.splice(0, 4);
        p.archive = [];
        p.folded = false;
        p.bet = room.mandatoryBet;
        p.chips -= room.mandatoryBet;
        p.defenses = 0;
        p.isReady = false;
        room.pot += room.mandatoryBet;
    });

    // Start with player 0
    room.currentTurn = getNextActivePlayer(room, -1);
}

function getNextActivePlayer(room, currentIndex, includeDefenders = false) {
    let nextIndex = currentIndex;
    let iterations = 0;
    while (iterations < room.players.length) {
        nextIndex = (nextIndex + 1) % room.players.length;
        const p = room.players[nextIndex];
        if (!p.folded && !p.disconnected) {
            return p.id;
        }
        iterations++;
    }
    return null; // Everyone folded?
}

function handleAction(roomId, playerId, actionData) {
    const room = rooms.get(roomId);
    if (!room || room.currentTurn !== playerId) return;

    if (room.phase === 'betting') {
        handleBettingAction(room, playerId, actionData);
    } else if (room.phase === 'attack') {
        handleAttackAction(room, playerId, actionData);
    } else if (room.phase === 'defense') {
        handleDefenseAction(room, playerId, actionData);
    }

    broadcastState(roomId);
}

function handleBettingAction(room, playerId, data) {
    const player = room.players.find(p => p.id === playerId);
    let playerIndex = room.players.findIndex(p => p.id === playerId);

    if (data.action === 'fold') {
        player.folded = true;
    } else if (data.action === 'check') {
        if (player.bet < room.currentBet) return; // Cannot check if there's a bet
    } else if (data.action === 'call') {
        const toCall = room.currentBet - player.bet;
        if (player.chips >= toCall) {
            player.chips -= toCall;
            player.bet += toCall;
            room.pot += toCall;
        } else {
            // All in (simplified)
            player.bet += player.chips;
            room.pot += player.chips;
            player.chips = 0;
        }
    } else if (data.action === 'raise') {
        const raiseAmount = parseInt(data.amount);
        const toCall = room.currentBet - player.bet;
        const total = toCall + raiseAmount;
        if (total > 0 && player.chips >= total) {
            player.chips -= total;
            player.bet += total;
            room.pot += total;
            room.currentBet += raiseAmount;
        }
    }

    // Check if betting round is over
    const activePlayers = room.players.filter(p => !p.folded && !p.disconnected);
    if (activePlayers.length === 1) {
        // Everyone folded, this player wins
        // Transition to finished
        room.phase = 'finished';
        activePlayers[0].chips += room.pot;
        return;
    }

    const allCalled = activePlayers.every(p => p.bet === room.currentBet);

    // Simple logic: if everyone has called or raised and it's back to the first who didn't raise, phase over
    // Let's just track if everyone has matching bets and has acted (simplified: we just check if everyone matches currentBet)
    // Actually, we need to ensure everyone had a chance. For simplicity, we assume round-robin until bets match.
    // Wait, if everyone's bet == currentBet, it might be the start of the round (all at 0).
    // We can add a 'hasActed' flag.
    player.hasActed = true;

    if (activePlayers.every(p => p.bet === room.currentBet && p.hasActed)) {
        // Round over
        activePlayers.forEach(p => { p.bet = 0; p.hasActed = false; });
        room.currentBet = 0;

        // Transition to next phase
        if (room.communityRevealed.every(r => r)) {
            room.phase = 'showdown';
            handleShowdown(room);
        } else {
            room.phase = 'attack';
            room.currentTurn = getNextActivePlayer(room, playerIndex);
            room.combat = { attacker: room.currentTurn, defender: null, attackCard: null };
            maybeTriggerBot(room);
            return;
        }
    } else {
        room.currentTurn = getNextActivePlayer(room, playerIndex);
        maybeTriggerBot(room);
    }
}

function handleAttackAction(room, playerId, data) {
    const player = room.players.find(p => p.id === playerId);
    let playerIndex = room.players.findIndex(p => p.id === playerId);

    if (data.action === 'attack' && data.cardId) {
        const cardIndex = player.hand.findIndex(c => c.id === data.cardId);
        if (cardIndex >= 0) {
            const card = player.hand.splice(cardIndex, 1)[0];
            room.combat.attackCard = card;
            room.phase = 'defense';
            room.currentTurn = getNextActivePlayer(room, playerIndex);
            room.combat.defender = room.currentTurn;

            // Add action to history for events
            broadcast(room.roomId, { type: 'event', event: 'cardPlayed', player: player.name, card: card.suit + card.rank });
            maybeTriggerBot(room);
        }
    } else if (data.action === 'skip') {
        // Player skips attack
        room.currentTurn = getNextActivePlayer(room, playerIndex);
        if (room.currentTurn === room.combat.attacker) {
            // Loop finished, check defenses and maybe reveal cards
            evaluateCommunityCards(room);
        } else {
            maybeTriggerBot(room);
        }
    }
}

function handleDefenseAction(room, playerId, data) {
    const player = room.players.find(p => p.id === playerId);
    const attacker = room.players.find(p => p.id === room.combat.attacker);

    if (data.action === 'defend' && data.cardId) {
        const cardIndex = player.hand.findIndex(c => c.id === data.cardId);
        if (cardIndex >= 0) {
            const defCard = player.hand[cardIndex];
            if (defCard.rankValue > room.combat.attackCard.rankValue) {
                // Successful defense
                player.hand.splice(cardIndex, 1);
                player.archive.push(defCard);
                // Attack card goes to discard (we just don't put it anywhere, it's removed)
                player.defenses += 1;

                broadcast(room.roomId, { type: 'event', event: 'defenseSuccess', player: player.name });
            } else {
                // Invalid defense (client shouldn't allow, but if they do)
                return;
            }
        }
    } else if (data.action === 'decline') {
        // Attack is successful, card goes to attacker's archive
        attacker.archive.push(room.combat.attackCard);

        // Defender must discard 1 randomly
        if (player.hand.length > 0) {
            const dropIdx = Math.floor(Math.random() * player.hand.length);
            player.hand.splice(dropIdx, 1);
        }
        broadcast(room.roomId, { type: 'event', event: 'attackSuccess', player: attacker.name });
    }

    // Move to next attacker
    room.phase = 'attack';
    room.currentTurn = getNextActivePlayer(room, room.players.findIndex(p => p.id === room.combat.attacker));
    room.combat = { attacker: room.currentTurn, defender: null, attackCard: null };

    evaluateCommunityCards(room);
}

function evaluateCommunityCards(room) {
    const activePlayers = room.players.filter(p => !p.folded && !p.disconnected);
    const minDefenses = Math.min(...activePlayers.map(p => p.defenses));

    let revealedSomething = false;
    if (minDefenses >= 1 && !room.communityRevealed[0]) {
        room.communityRevealed[0] = room.communityRevealed[1] = room.communityRevealed[2] = true;
        revealedSomething = true;
    }
    if (minDefenses >= 2 && !room.communityRevealed[3]) {
        room.communityRevealed[3] = true;
        revealedSomething = true;
    }
    if (minDefenses >= 3 && !room.communityRevealed[4]) {
        room.communityRevealed[4] = true;
        revealedSomething = true;
    }

    // Also if everyone's hand is empty, we must reveal everything and go to showdown
    const handsEmpty = activePlayers.every(p => p.hand.length === 0);
    if (handsEmpty) {
        room.communityRevealed = [true, true, true, true, true];
        revealedSomething = true;
    }

    if (revealedSomething) {
        room.phase = 'betting';
        room.currentTurn = getNextActivePlayer(room, -1);
        room.players.forEach(p => p.hasActed = false);
        if (room.communityRevealed.every(r => r) && handsEmpty) {
            room.phase = 'showdown';
            handleShowdown(room);
        }
    }
    maybeTriggerBot(room);
}


function evaluateBestHand(cards) {
    if (cards.length < 5) return { score: 0, name: "High Card" };

    let bestScore = -1;
    let bestName = "";

    // Combinations helper
    function getCombinations(array, size) {
        let result = [];
        function p(t, i) {
            if (t.length === size) {
                result.push(t);
                return;
            }
            if (i + 1 <= array.length) {
                p(t.concat(array[i]), i + 1);
                p(t, i + 1);
            }
        }
        p([], 0);
        return result;
    }

    const combos = getCombinations(cards, 5);

    for (let combo of combos) {
        combo.sort((a, b) => b.rankValue - a.rankValue);

        let isFlush = combo.every(c => c.suit === combo[0].suit);
        let isStraight = true;
        for (let i = 1; i < 5; i++) {
            if (combo[i - 1].rankValue - combo[i].rankValue !== 1) isStraight = false;
        }
        // Handle A-5 straight (A=14, 5=5,4,3,2 => 14,5,4,3,2)
        if (!isStraight && combo[0].rankValue === 14 && combo[1].rankValue === 5 && combo[2].rankValue === 4 && combo[3].rankValue === 3 && combo[4].rankValue === 2) {
            isStraight = true;
            // Treat A as 1 for scoring purposes
            combo.push(combo.shift());
        }

        const counts = {};
        combo.forEach(c => counts[c.rankValue] = (counts[c.rankValue] || 0) + 1);
        const freqs = Object.values(counts).sort((a, b) => b - a);

        let score = 0;
        let name = "";

        const rankScore = combo.reduce((acc, c, idx) => acc + c.rankValue * Math.pow(15, 4 - idx), 0);

        if (isStraight && isFlush) {
            if (combo[0].rankValue === 14 && combo[1].rankValue === 13) name = "Royal Flush";
            else name = "Straight Flush";
            score = 8000000 + rankScore;
        } else if (freqs[0] === 4) {
            name = "Four of a Kind";
            let quadRank = parseInt(Object.keys(counts).find(k => counts[k] === 4));
            score = 7000000 + quadRank * 10000;
        } else if (freqs[0] === 3 && freqs[1] === 2) {
            name = "Full House";
            let tripRank = parseInt(Object.keys(counts).find(k => counts[k] === 3));
            score = 6000000 + tripRank * 10000;
        } else if (isFlush) {
            name = "Flush";
            score = 5000000 + rankScore;
        } else if (isStraight) {
            name = "Straight";
            score = 4000000 + rankScore;
        } else if (freqs[0] === 3) {
            name = "Three of a Kind";
            let tripRank = parseInt(Object.keys(counts).find(k => counts[k] === 3));
            score = 3000000 + tripRank * 10000 + rankScore;
        } else if (freqs[0] === 2 && freqs[1] === 2) {
            name = "Two Pair";
            // Need to sort pairs
            let pairs = Object.keys(counts).filter(k => counts[k] === 2).map(Number).sort((a,b)=>b-a);
            score = 2000000 + pairs[0] * 10000 + pairs[1] * 100 + rankScore;
        } else if (freqs[0] === 2) {
            name = "Pair";
            let pairRank = parseInt(Object.keys(counts).find(k => counts[k] === 2));
            score = 1000000 + pairRank * 10000 + rankScore;
        } else {
            name = "High Card";
            score = rankScore;
        }

        if (score > bestScore) {
            bestScore = score;
            bestName = name;
        }
    }

    return { score: bestScore, name: bestName };
}

function handleShowdown(room) {
    const activePlayers = room.players.filter(p => !p.folded && !p.disconnected);
    let bestScore = -1;
    let winner = null;
    let bestCombo = "High Card";
    activePlayers.forEach(p => {
        let allCards = [...room.communityCards, ...p.archive];
        let evalHand = evaluateBestHand(allCards);
        if (evalHand.score > bestScore) {
            bestScore = evalHand.score;
            winner = p;
            bestCombo = evalHand.name;
        }
    });
    if (winner) {
        winner.chips += room.pot;
        broadcast(room.roomId, { type: 'winner', winner: winner.name, combination: bestCombo });
    }
    room.phase = 'finished';

    // Auto-ready bots for next round, remove disconnected players
    setTimeout(() => {
        room.players = room.players.filter(p => !p.disconnected);
        room.players.filter(p => p.isBot).forEach(b => b.isReady = true);
        broadcastState(room.roomId);
        if (room.players.length >= 2 && room.players.every(p => p.isReady)) {
            startGame(room);
            broadcastState(room.roomId);
            maybeTriggerBot(room);
        }
    }, 5000); // 5 seconds wait before bots auto-ready
}


function joinBot(roomId) {
    let room = rooms.get(roomId);
    if (!room) return;
    const botId = `bot_${Math.random().toString(36).substring(2, 9)}`;
    room.players.push({
        id: botId, name: 'AI_Bot', chips: 1000, hand: [], archive: [],
        folded: false, disconnected: false, isReady: true, bet: 0, defenses: 0, isBot: true
    });
    broadcastState(roomId);
    if (room.players.length >= 2 && room.players.every(p => p.isReady)) {
        startGame(room);
        broadcastState(roomId);
        maybeTriggerBot(room);
    }
}

function maybeTriggerBot(room) {
    if (!room.currentTurn || room.phase === 'finished' || room.phase === 'showdown') return;
    const player = room.players.find(p => p.id === room.currentTurn);
    if (player && player.isBot) {
        setTimeout(() => playBotTurn(room, player), 1000);
    }
}

function playBotTurn(room, bot) {
    if (room.phase === 'betting') {
        const toCall = room.currentBet - bot.bet;
        if (toCall === 0) handleAction(room.roomId, bot.id, { action: 'check' });
        else handleAction(room.roomId, bot.id, { action: 'call' });
    } else if (room.phase === 'attack') {
        if (bot.hand.length > 0) handleAction(room.roomId, bot.id, { action: 'attack', cardId: bot.hand[0].id });
        else handleAction(room.roomId, bot.id, { action: 'skip' });
    } else if (room.phase === 'defense') {
        const attackCard = room.combat.attackCard;
        const validDefense = bot.hand.find(c => c.rankValue > attackCard.rankValue);
        if (validDefense) handleAction(room.roomId, bot.id, { action: 'defend', cardId: validDefense.id });
        else handleAction(room.roomId, bot.id, { action: 'decline' });
    }
}

function handleDisconnect(ws) {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
        const room = rooms.get(clientInfo.roomId);
        if (room) {
            const player = room.players.find(p => p.id === clientInfo.playerId);
            if (player) {
                player.disconnected = true;
                player.folded = true; // Auto fold on disconnect for simplicity
                console.log(`Player ${player.name} disconnected`);

                // If it was their turn, advance
                if (room.currentTurn === player.id) {
                    room.currentTurn = getNextActivePlayer(room, room.players.findIndex(p => p.id === player.id));
                }

                broadcastState(clientInfo.roomId);
            }
        }
        clients.delete(ws);
    }
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
