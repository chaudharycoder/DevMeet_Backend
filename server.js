/**
 * BACKEND SERVER - Skribbl-like Game
 * 
 * PREREQUISITES:
 * 1. Node.js installed on your machine.
 * 2. Basic understanding of JavaScript (ES6+).
 * 3. Understanding of Express (web framework for Node.js).
 * 4. Understanding of Socket.io (real-time, bidirectional communication).
 * 
 * SYSTEM FLOW:
 * 1. Connection: A user connects via socket.io.
 * 2. Authentication: User sends a 'set-username' event to join the game.
 * 3. Role Assignment: 
 *    - The first user becomes the 'drawer'.
 *    - Subsequent users become 'viewers'.
 * 4. Game Loop:
 *    - The drawer gets a 'secretWord' and draws on the canvas.
 *    - Viewers try to guess the word in the chat.
 *    - If a viewer guesses correctly, they get points, and roles rotate.
 *    - If the timer (50s) runs out, roles rotate automatically.
 * 5. State Management: The server tracks users, scores, the current drawer, and the secret word.
 */

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

// Initialize Express app
const app = express();
app.use(cors()); // Enable CORS to allow frontend to communicate with backend

// Create HTTP server using Express app
const httpServer = createServer(app);

// Initialize Socket.io server
// origin: allows requests from vite's default ports
const io = new Server(httpServer, {
    cors: {
        origin: "*", // In production, you might want to restrict this to your specific frontend URL
        methods: ["GET", "POST"]
    }
});

// --- GLOBAL GAME STATE ---
let currentDrawer = null;          // Socket ID of the user currently drawing
const users = {};                   // Map of socket.id -> username
const scorecard = {};               // Map of socket.id -> score
let secretWord = null;              // The word that needs to be guessed
const words = ["cat", "car", "tree", "house", "apple", "sun", "moon", "fish", "bird", "book"];
let timer = null;                   // Reference to the setInterval timer
let timeLeft = 50;                  // Initial time for each drawing round

/**
 * Returns a random word from the words array.
 */
function getRandomWord() {
    return words[Math.floor(Math.random() * words.length)];
}

/**
 * Starts/Restarts the 50-second round timer.
 * Emits 'timer-update' to all connected clients every second.
 */
function startTimer() {
    if (timer) clearInterval(timer); // Reset any existing timer
    timeLeft = 50;
    io.emit("timer-update", timeLeft); // Tell everyone the new time
    console.log("Timer restarted: 50s");

    timer = setInterval(() => {
        timeLeft--;
        io.emit("timer-update", timeLeft);

        if (timeLeft <= 0) {
            console.log("Time up! Rotating drawer...");
            clearInterval(timer);
            rotateDrawer(); // Move to the next user when time is up
        }
    }, 1000);
}

/**
 * Handles the rotation of the 'drawer' role among connected users.
 * Also selects a new secret word and updates roles for everyone.
 */
function rotateDrawer() {
    const userIds = Object.keys(users);

    // If no users are left, reset the game state
    if (userIds.length === 0) {
        console.log("No users left. Clearing timer.");
        if (timer) clearInterval(timer);
        currentDrawer = null;
        secretWord = null;
        return;
    }

    // Find the current drawer's index and move to the next one (circularly)
    const currentIndex = userIds.indexOf(currentDrawer);
    const nextIndex = (currentIndex + 1) % userIds.length;
    currentDrawer = userIds[nextIndex];

    // Pick a new word for the new drawer
    secretWord = getRandomWord();
    console.log(`New drawer: ${users[currentDrawer]} (${currentDrawer}). Word: ${secretWord}`);

    // Notify clients to clear their canvas and update drawer info
    io.emit("clear");
    io.emit("drawer-update", users[currentDrawer]);

    // Update roles for each connected socket individually
    io.sockets.sockets.forEach((s) => {
        if (s.id === currentDrawer) {
            s.emit("role", "drawer");
            s.emit("word", secretWord); // Only the drawer sees the secret word
        } else {
            s.emit("role", "viewer");
        }
    });

    // Broadcast updated user list and start the countdown
    io.emit("users-list", { users, scorecard });
    startTimer();
}

// --- SOCKET.IO EVENT HANDLERS ---
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    /**
     * Event: 'set-username'
     * Triggered when a user enters their name on the frontend.
     */
    socket.on("set-username", (username) => {
        users[socket.id] = username;
        scorecard[socket.id] = 0;

        // If this is the first user, make them the drawer immediately
        if (!currentDrawer) {
            currentDrawer = socket.id;
            secretWord = getRandomWord();
            startTimer();
        }

        // Assign initial role to the user who just joined
        if (socket.id === currentDrawer) {
            socket.emit("role", "drawer");
            socket.emit("word", secretWord);
        } else {
            socket.emit("role", "viewer");
        }

        // Inform everyone about the new user and current state
        io.emit("users-list", { users, scorecard });
        io.emit("drawer-update", users[currentDrawer]);
        io.emit("timer-update", timeLeft);

        console.log(`User set: ${username} (${socket.id})`);
    });

    /**
     * Event: 'draw'
     * Receives drawing data (coordinates) from the current drawer and broadcasts it.
     */
    socket.on("draw", (data) => {
        if (socket.id !== currentDrawer) return; // Ignore if not from drawer
        socket.broadcast.emit("draw", data);
    });

    /**
     * Event: 'clear'
     * Receives clear canvas request from the drawer and broadcasts it.
     */
    socket.on("clear", () => {
        if (socket.id !== currentDrawer) return;
        io.emit("clear");
    });

    /**
     * Event: 'chat' / Guess logic
     * Handles normal messages and checks if a viewer guessed the secret word.
     */
    socket.on("chat", (message) => {
        const name = users[socket.id] || "Unknown";

        // Current drawer's chat is just broadcasted (they shouldn't guess)
        if (socket.id === currentDrawer) {
            socket.broadcast.emit("chat", { name, message });
            return;
        }

        // CHECK GUESS: Case-insensitive match with secret word
        if (secretWord && message.toLowerCase() === secretWord.toLowerCase()) {
            scorecard[socket.id] += 100; // Reward the guesser
            io.emit("chat", {
                name: "System",
                message: `${name} guessed the word correctly!`,
            });

            io.emit("score-update", scorecard);
            io.emit("users-list", { users, scorecard });

            // On correct guess, stop the timer and move to the next round
            if (timer) clearInterval(timer);
            rotateDrawer();
        } else {
            // Normal message broadcast
            socket.broadcast.emit("chat", { name, message });
        }
    });

    /**
     * Event: 'request-initial-state'
     * Used by the frontend to get the current game status (users, drawer, timer) after connecting.
     */
    socket.on("request-initial-state", () => {
        socket.emit("users-list", { users, scorecard });
        socket.emit("drawer-update", users[currentDrawer]);
        socket.emit("timer-update", timeLeft);
        if (socket.id === currentDrawer) {
            socket.emit("role", "drawer");
            socket.emit("word", secretWord);
        } else {
            socket.emit("role", "viewer");
        }
    });

    /**
     * Event: 'disconnect'
     * Cleans up user data when they leave.
     */
    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
        const wasDrawer = (socket.id === currentDrawer);
        delete users[socket.id];
        delete scorecard[socket.id];

        // If the drawer leaves, we must pick a new one immediately
        if (wasDrawer) {
            console.log("Drawer disconnected. Rotating...");
            if (timer) clearInterval(timer);
            rotateDrawer();
        } else {
            io.emit("users-list", { users, scorecard });
        }
    });
});

// START THE SERVER
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
