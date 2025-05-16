const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const questionsData = require('./questions.json');
const ALL_QUESTIONS = questionsData.questions;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all for dev, restrict in prod e.g. process.env.CLIENT_URL
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

// --- Game State ---
let users = {}; // { socketId: { id (userId), username, socketId } }
let userIdToSocketId = {}; // { userId: socketId }
let hostId = null; // Stores socketId of the host
let gameState = {
    phase: 'lobby', // 'lobby', 'playing-question', 'playing-reveal', 'round-end'
    currentQuestionPair: null, // { id, normal, imposter }
    imposterId: null, // userId of the imposter
    answers: {}, // { userId: { username, answer, isImposter } }
    usedQuestionIds: [],
    roundNumber: 0,
    playersReadyForNextRound: new Set(), // For host 'Next Round' button logic
};

const MAX_PLAYERS = 10;
const MIN_PLAYERS_TO_START = 3;

// Serve static files from the React app build folder
app.use(express.static(path.join(__dirname, '..', 'client', 'build')));


// --- Helper Functions ---
function getPlayersList() {
    return Object.values(users).map(u => ({ id: u.id, username: u.username }));
}

function chooseNewHost() {
    const playerSocketIds = Object.keys(users);
    if (playerSocketIds.length > 0) {
        hostId = playerSocketIds[0]; // Assign the first user in the list
        if (users[hostId]) {
             console.log(`New host assigned: ${users[hostId].username} (${hostId})`);
        } else {
            console.log(`New host assigned: ${hostId} (details pending user object update)`);
        }
        io.emit('host-changed', { newHostId: users[hostId]?.id });
    } else {
        hostId = null;
        console.log('No users left to assign as host.');
    }
    broadcastLobbyUpdate();
}

function broadcastLobbyUpdate() {
    io.emit('lobby-update', {
        players: getPlayersList(),
        hostId: users[hostId]?.id,
        gameState: { phase: gameState.phase }
    });
}

function resetGame() {
    gameState.phase = 'lobby';
    gameState.currentQuestionPair = null;
    gameState.imposterId = null;
    gameState.answers = {};
    gameState.usedQuestionIds = [];
    gameState.roundNumber = 0;
    gameState.playersReadyForNextRound.clear();
    console.log("Game reset to lobby state.");
    broadcastLobbyUpdate();
}


function startNewRound() {
    if (Object.keys(users).length < MIN_PLAYERS_TO_START) {
        io.to(hostId).emit('game-error', { message: `Need at least ${MIN_PLAYERS_TO_START} players to start a new round.` });
        resetGame(); // Go back to lobby if not enough players
        return;
    }

    // Select imposter
    const playerIds = Object.values(users).map(u => u.id);
    gameState.imposterId = playerIds[Math.floor(Math.random() * playerIds.length)];

    // Select question
    const availableQuestions = ALL_QUESTIONS.filter(q => !gameState.usedQuestionIds.includes(q.id));
    if (availableQuestions.length === 0) {
        // All questions used, reset or end game
        gameState.usedQuestionIds = []; // Reset for now, could also end game.
        // Optionally send a message like "All questions used! Resetting question pool."
        const newAvailableQuestions = ALL_QUESTIONS.filter(q => !gameState.usedQuestionIds.includes(q.id));
        if (newAvailableQuestions.length === 0) { // Should not happen if ALL_QUESTIONS is not empty
            io.emit('game-error', { message: 'No questions available to start a round.' });
            resetGame();
            return;
        }
        gameState.currentQuestionPair = newAvailableQuestions[Math.floor(Math.random() * newAvailableQuestions.length)];
    } else {
        gameState.currentQuestionPair = availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
    }
    
    gameState.usedQuestionIds.push(gameState.currentQuestionPair.id);
    gameState.answers = {};
    gameState.phase = 'playing-question';
    gameState.roundNumber++;
    gameState.playersReadyForNextRound.clear();

    console.log(`Starting round ${gameState.roundNumber}. Imposter: ${users[userIdToSocketId[gameState.imposterId]]?.username}. Question ID: ${gameState.currentQuestionPair.id}`);

    // Send questions to players
    Object.values(users).forEach(user => {
        const questionText = user.id === gameState.imposterId ? gameState.currentQuestionPair.imposter : gameState.currentQuestionPair.normal;
        io.to(user.socketId).emit('new-round', {
            roundNumber: gameState.roundNumber,
            question: questionText,
            isImposter: user.id === gameState.imposterId,
            gameState: { phase: gameState.phase }
        });
    });
    // Also broadcast overall game state for UI updates
    io.emit('game-state-update', {
        phase: gameState.phase,
        roundNumber: gameState.roundNumber,
        hostId: users[hostId]?.id,
        // do not send imposterId or full question pair here to all
    });
}

// --- Socket.IO Connections ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('request-session-restore', ({ userId }) => {
        if (userId && userIdToSocketId[userId]) {
            const oldSocketId = userIdToSocketId[userId];
            const user = users[oldSocketId];
            if (user) {
                // Update socket ID for existing user
                delete users[oldSocketId];
                users[socket.id] = { ...user, socketId: socket.id };
                userIdToSocketId[userId] = socket.id;
                socket.userId = userId; // Persist on socket object

                // If was host, update hostId
                if (hostId === oldSocketId) {
                    hostId = socket.id;
                }
                
                console.log(`User ${user.username} (ID: ${userId}) reconnected with new socket ${socket.id}`);
                socket.emit('session-restored', {
                    user: { id: user.id, username: user.username },
                    players: getPlayersList(),
                    hostId: users[hostId]?.id,
                    gameState // Send full current game state
                });
                // If game is in progress, send them current round info
                if (gameState.phase !== 'lobby' && gameState.currentQuestionPair) {
                     const questionText = user.id === gameState.imposterId ? gameState.currentQuestionPair.imposter : gameState.currentQuestionPair.normal;
                     socket.emit('new-round', { // or a more specific 'rejoin-round' event
                        roundNumber: gameState.roundNumber,
                        question: questionText,
                        isImposter: user.id === gameState.imposterId,
                        gameState: { phase: gameState.phase },
                        answers: gameState.answers, // send current answers too
                        currentQuestionNormal: gameState.currentQuestionPair.normal // for post-reveal phase
                     });
                }
                broadcastLobbyUpdate(); // Update all clients
            } else {
                 socket.emit('session-restore-failed'); // User was in map, but not in users obj (should not happen)
            }
        } else {
            socket.emit('session-restore-failed'); // No session to restore
        }
    });


    socket.on('join-game', ({ username, userId }) => {
        if (!username || username.trim() === '') {
            socket.emit('game-error', { message: 'Username cannot be blank.' });
            return;
        }
        if (Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== userId)) {
            socket.emit('game-error', { message: 'Username is already taken.' });
            return;
        }
        if (Object.keys(users).length >= MAX_PLAYERS && !users[socket.id]) { // !users[socket.id] to allow rejoining player if lobby is full
            socket.emit('game-error', { message: 'Lobby is full.' });
            return;
        }

        const newUserId = userId || uuidv4(); // Use provided userId for reconnect/refresh, else generate new
        users[socket.id] = { id: newUserId, username, socketId: socket.id };
        userIdToSocketId[newUserId] = socket.id;
        socket.userId = newUserId; // Store on socket for easier access

        if (!hostId || !users[hostId]) { // Assign host if no host or previous host left
            hostId = socket.id;
            io.emit('host-changed', { newHostId: newUserId });
        }
        
        console.log(`${username} (ID: ${newUserId}) joined the game.`);
        socket.emit('join-success', { userId: newUserId, username }); // Send generated/confirmed userId back
        broadcastLobbyUpdate();
    });

    socket.on('start-game', () => {
        if (socket.id !== hostId) {
            socket.emit('game-error', { message: 'Only the host can start the game.' });
            return;
        }
        if (Object.keys(users).length < MIN_PLAYERS_TO_START) {
            socket.emit('game-error', { message: `Need at least ${MIN_PLAYERS_TO_START} players to start.` });
            return;
        }
        console.log(`Host ${users[hostId]?.username} started the game.`);
        startNewRound();
        io.emit('game-started', { // Let all clients know game is on
            phase: gameState.phase,
            hostId: users[hostId]?.id
        }); 
    });

    socket.on('submit-answer', ({ answer }) => {
        const user = users[socket.id];
        if (!user || gameState.phase !== 'playing-question') {
            socket.emit('game-error', { message: 'Not valid time to submit or user not found.' });
            return;
        }
        if (gameState.answers[user.id]) {
            socket.emit('game-error', { message: 'You have already submitted an answer.' });
            return;
        }

        gameState.answers[user.id] = {
            username: user.username,
            answer: answer,
            isImposter: user.id === gameState.imposterId // Store this for later checks if needed, but don't reveal yet
        };
        console.log(`Answer from ${user.username}: ${answer}`);
        
        // Notify players that an answer was submitted (e.g., to show checkmarks)
        io.emit('answer-update', {
            // Send only usernames of who submitted, or count.
            // For simplicity, just re-sending all answers (client will handle display)
            // Or, more efficiently:
             submittedCount: Object.keys(gameState.answers).length,
             totalPlayers: Object.keys(users).length
        });


        // Check if all players have submitted
        if (Object.keys(gameState.answers).length === Object.keys(users).length) {
            gameState.phase = 'playing-reveal';
            console.log('All answers submitted. Revealing answers.');
            io.emit('all-answers-submitted', {
                answers: Object.values(gameState.answers).map(a => ({ username: a.username, answer: a.answer })), // Don't send isImposter flag to client
                currentQuestionNormal: gameState.currentQuestionPair.normal,
                gameState: { phase: gameState.phase }
            });
        }
    });

    socket.on('host-continue-tts', () => {
        if (socket.id !== hostId || gameState.phase !== 'playing-reveal') {
            socket.emit('game-error', { message: 'Only host can do this now.'});
            return;
        }
        if (gameState.currentQuestionPair && gameState.currentQuestionPair.normal) {
            console.log(`Host requested TTS for: ${gameState.currentQuestionPair.normal}`);
            // This now directly tells clients to speak the text using browser's SpeechSynthesis
            io.emit('play-tts-text', { text: gameState.currentQuestionPair.normal });
            gameState.phase = 'round-end'; // Update phase after TTS trigger
            io.emit('game-state-update', { // Inform clients of phase change
                phase: gameState.phase,
                hostId: users[hostId]?.id
            });
        }
    });

    socket.on('host-next-round', () => {
        if (socket.id !== hostId || gameState.phase !== 'round-end') {
             socket.emit('game-error', { message: 'Only host can start the next round at this time.'});
            return;
        }
        if (Object.keys(gameState.answers).length !== Object.keys(users).length && gameState.roundNumber > 0) {
            // This check might be redundant if phase 'round-end' is strictly managed
            socket.emit('game-error', { message: 'Cannot proceed, not all answers were submitted in previous phase.' });
            return;
        }
        console.log(`Host ${users[hostId]?.username} requested next round.`);
        startNewRound();
    });
    
    socket.on('leave-game', () => {
        console.log(`User ${users[socket.id]?.username} (ID: ${socket.userId}, Socket: ${socket.id}) requested to leave.`);
        handleDisconnect(socket); // Use the common disconnect logic
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}, userId: ${socket.userId}`);
        handleDisconnect(socket);
    });

    function handleDisconnect(socketInstance) {
        const user = users[socketInstance.id];
        if (user) {
            console.log(`Player ${user.username} (ID: ${user.id}) is leaving/disconnecting.`);
            delete users[socketInstance.id];
            delete userIdToSocketId[user.id]; // Important for preventing old socket ID reuse by mistake

            // If the game is in progress and they haven't answered, it might stall.
            // Check if all remaining players have answered if in 'playing-question' phase
            if (gameState.phase === 'playing-question' && Object.keys(users).length > 0 &&
                Object.keys(gameState.answers).length === Object.keys(users).length) {
                
                // Filter out the disconnected user's potential answer if it existed
                if (gameState.answers[user.id]) {
                    delete gameState.answers[user.id];
                }

                // Re-check if all *remaining* players have answered
                const remainingUserIds = Object.values(users).map(u => u.id);
                const allRemainingAnswered = remainingUserIds.every(uid => gameState.answers[uid]);

                if (allRemainingAnswered && remainingUserIds.length > 0) {
                    gameState.phase = 'playing-reveal';
                    console.log('All remaining answers submitted after a player left. Revealing answers.');
                    io.emit('all-answers-submitted', {
                        answers: Object.values(gameState.answers).map(a => ({ username: a.username, answer: a.answer })),
                        currentQuestionNormal: gameState.currentQuestionPair.normal,
                        gameState: { phase: gameState.phase }
                    });
                }
            }


            if (socketInstance.id === hostId) {
                console.log(`Host ${user.username} disconnected. Choosing new host.`);
                chooseNewHost();
            }
            
            // If no players left and game was active, reset it
            if (Object.keys(users).length === 0 && gameState.phase !== 'lobby') {
                console.log("All players left. Resetting game.");
                resetGame();
            } else {
                 broadcastLobbyUpdate(); // Update player list for everyone
            }

        } else {
            console.log(`Socket ${socketInstance.id} (unknown user) disconnected.`);
        }
    }
});


// Fallback to serve index.html for any route not handled by API or static files
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html'));
});


server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Frontend expected at http://localhost:3000 (if using CRA dev server)`);
    console.log(`Or server will serve static build from client/build`);
});

// Placeholder for /api/tts - see README for cloud integration
// For now, TTS is handled client-side via 'play-tts-text' event
app.get('/api/tts', async (req, res) => {
    const { text } = req.query;
    if (!text) {
        return res.status(400).json({ error: 'Missing text parameter' });
    }

    // THIS IS WHERE YOU'D INTEGRATE A CLOUD TTS PROVIDER
    // Example: Google Cloud Text-to-Speech
    // const textToSpeech = require('@google-cloud/text-to-speech');
    // const client = new textToSpeech.TextToSpeechClient(); // Ensure GOOGLE_APPLICATION_CREDENTIALS is set
    // try {
    //   const request = {
    //     input: { text: text },
    //     voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
    //     audioConfig: { audioEncoding: 'MP3' },
    //   };
    //   const [response] = await client.synthesizeSpeech(request);
    //   res.set('Content-Type', 'audio/mpeg');
    //   res.send(response.audioContent);
    // } catch (error) {
    //   console.error('ERROR generating TTS via cloud:', error);
    //   res.status(500).json({ error: 'Failed to generate TTS audio' });
    // }

    // Fallback / Placeholder message if no cloud TTS is integrated:
    console.warn_once("TTS endpoint hit, but cloud TTS provider not fully implemented. Client will use browser synthesis.");
    res.status(501).json({
        message: "Cloud TTS not implemented on server. Client should use browser synthesis.",
        requestedText: text
    });
});

// Utility to log a warning only once
const warned = {};
console.warn_once = (message) => {
    if (!warned[message]) {
        console.warn(message);
        warned[message] = true;
    }
};