const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();

const db = require('./database/db');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Configure Multer for file storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// Blockchain configuration
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:7545"; // Default Ganache RPC URL
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// ABI for the DocumentVerification contract (replace after deployment)
const CONTRACT_ABI = [
    "function addDocument(string memory _hash) public",
    "function verifyDocument(string memory _hash) public view returns (bool)"
];

let provider, signer, contract;

// Connect to the blockchain
const initBlockchain = async () => {
    try {
        if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
            console.warn("Blockchain configuration missing (.env). System will use local database only.");
            return;
        }
        provider = new ethers.JsonRpcProvider(RPC_URL);
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
        console.log("Connected to Blockchain.");
    } catch (err) {
        console.error("Failed to connect to blockchain:", err.message);
    }
};

initBlockchain();

// Helper to generate SHA-256 hash of a file
const generateHash = (filePath) => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', err => reject(err));
    });
};

// API: Upload Document
app.post('/upload', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send({ message: "No file uploaded." });

        const filePath = req.file.path;
        const fileName = req.file.originalname;
        const hash = await generateHash(filePath);

        // Store in local SQLite
        const sql = `INSERT INTO documents (document_name, hash) VALUES (?, ?)`;
        db.run(sql, [fileName, hash], async (err) => {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).send({ message: "Document already uploaded." });
                }
                return res.status(500).send({ message: "Database error." });
            }

            // Store in Blockchain
            if (contract) {
                try {
                    const tx = await contract.addDocument(hash);
                    await tx.wait();
                    console.log(`Document hash stored on Blockchain: ${hash}`);
                } catch (bErr) {
                    console.error("Blockchain storage failed:", bErr.message);
                }
            }

            res.send({ message: "Document uploaded successfully!", hash });
        });
    } catch (err) {
        res.status(500).send({ message: "Server error.", error: err.message });
    }
});

// API: Verify Document
app.post('/verify', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send({ message: "No file uploaded." });

        const filePath = req.file.path;
        const hash = await generateHash(filePath);

        // Clean up temp file
        fs.unlinkSync(filePath);

        // Check Blockchain status
        let isOriginal = false;
        if (contract) {
            try {
                isOriginal = await contract.verifyDocument(hash);
            } catch (bErr) {
                console.error("Blockchain verification failed:", bErr.message);
            }
        } else {
            // Fallback to local SQLite if blockchain is unavailable
            return new Promise((resolve, reject) => {
                db.get(`SELECT id FROM documents WHERE hash = ?`, [hash], (err, row) => {
                    if (err) return res.status(500).send({ message: "Database error." });
                    res.send({ isOriginal: !!row, hash });
                });
            });
        }

        res.send({ isOriginal, hash });
    } catch (err) {
        res.status(500).send({ message: "Server error.", error: err.message });
    }
});

// API: List All Documents
app.get('/documents', (req, res) => {
    db.all(`SELECT * FROM documents ORDER BY upload_date DESC`, [], (err, rows) => {
        if (err) return res.status(500).send({ message: "Database error." });
        res.send(rows);
    });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
