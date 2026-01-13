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
        origin: process.env.ALLOWED_ORIGIN || "https://devmeetfrontend.vercel.app", // In production, you might want to restrict this to your specific frontend URL
        methods: ["GET", "POST"]
    }
});

// --- GLOBAL STATE ---
// rooms = { roomID: { users: { socketID: username }, currentDrawer: socketID } }
const rooms = {};

/**
 * Handles the assignment of the 'drawer' role within a specific room.
 */
function assignNewDrawer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const userIds = Object.keys(room.users);

    if (userIds.length === 0) {
        delete rooms[roomId];
        return;
    }

    // Pick the next user
    if (!room.currentDrawer || !room.users[room.currentDrawer]) {
        room.currentDrawer = userIds[0];
    } else {
        const currentIndex = userIds.indexOf(room.currentDrawer);
        const nextIndex = (currentIndex + 1) % userIds.length;
        room.currentDrawer = userIds[nextIndex];
    }

    // Notify clients in the room
    io.to(roomId).emit("clear");
    io.to(roomId).emit("drawer-update", room.users[room.currentDrawer]);

    // Update roles individually
    io.in(roomId).fetchSockets().then((sockets) => {
        sockets.forEach((s) => {
            if (s.id === room.currentDrawer) {
                s.emit("role", "drawer");
            } else {
                s.emit("role", "viewer");
            }
        });
    });

    io.to(roomId).emit("users-list", { users: room.users });
}

// --- SOCKET.IO EVENT HANDLERS ---
io.on("connection", (socket) => {
    let currentRoom = null;
    let myUsername = null;

    console.log("User connected:", socket.id);

    /**
     * Event: 'join-room'
     * A user joins a specific meeting room.
     */
    socket.on("join-room", ({ roomId, username }) => {
        currentRoom = roomId;
        myUsername = username;

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                users: {},
                currentDrawer: null
            };
        }

        rooms[roomId].users[socket.id] = username;

        // If first user, make them drawer
        if (!rooms[roomId].currentDrawer) {
            rooms[roomId].currentDrawer = socket.id;
        }

        // Notify others in room that a new peer joined (WebRTC)
        socket.to(roomId).emit("peer-joined", { socketId: socket.id, username });

        // Update roles and user list
        if (socket.id === rooms[roomId].currentDrawer) {
            socket.emit("role", "drawer");
        } else {
            socket.emit("role", "viewer");
        }

        io.to(roomId).emit("users-list", { users: rooms[roomId].users });
        io.to(roomId).emit("drawer-update", rooms[roomId].users[rooms[roomId].currentDrawer]);

        console.log(`User ${username} joined room ${roomId}`);
    });

    /**
     * WebRTC Signaling Handlers
     */
    socket.on("offer", ({ to, offer }) => {
        socket.to(to).emit("offer", { from: socket.id, offer });
    });

    socket.on("answer", ({ to, answer }) => {
        socket.to(to).emit("answer", { from: socket.id, answer });
    });

    socket.on("ice-candidate", ({ to, candidate }) => {
        socket.to(to).emit("ice-candidate", { from: socket.id, candidate });
    });

    /**
     * Collaborative Whiteboard Handlers
     */
    socket.on("draw", (data) => {
        if (!currentRoom) return;
        socket.to(currentRoom).emit("draw", data);
    });

    socket.on("clear", () => {
        if (!currentRoom) return;
        io.to(currentRoom).emit("clear");
    });

    /**
     * Chat Handler
     */
    socket.on("chat", (message) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit("chat", { name: myUsername || "Unknown", message });
    });

    /**
     * Disconnect Handler
     */
    socket.on("disconnect", () => {
        if (currentRoom && rooms[currentRoom]) {
            const wasDrawer = (socket.id === rooms[currentRoom].currentDrawer);
            delete rooms[currentRoom].users[socket.id];

            console.log(`User ${myUsername} disconnected from ${currentRoom}`);

            if (wasDrawer) {
                assignNewDrawer(currentRoom);
            } else {
                io.to(currentRoom).emit("users-list", { users: rooms[currentRoom].users });
            }

            // Notify others for WebRTC cleanup
            socket.to(currentRoom).emit("peer-left", socket.id);
        }
    });
});

// START THE SERVER
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
