const express = require('express');
const https = require('https');
const fs = require('fs');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
//const PORT = 3000;
//const MONGO_URI = "mongodb://localhost:27017";
const DATABASE_NAME = "gameDB";
const COLLECTION_NAME = "games";
const PORT = process.env.PORT;
const cors = require('cors');


app.use(express.json());  // Middleware to parse JSON request bodies

// Connect to MongoDB
const connectDB = async () => {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    return client.db(DATABASE_NAME).collection(COLLECTION_NAME);
};

// Load SSL/TLS certificates
const SSL_KEY_PATH = 'ssl/server.key';
const SSL_CERT_PATH = 'ssl/server.cert';

if (fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
    // Start HTTPS Server
    const httpsOptions = {
        key: fs.readFileSync(SSL_KEY_PATH),
        cert: fs.readFileSync(SSL_CERT_PATH),
    };

    https.createServer(httpsOptions, app).listen(PORT, () => {
        console.log(`HTTPS Server running on https://localhost:${PORT}`);
    });
} else {
    console.warn("SSL certificates not found! Running server on HTTP.");
    
    // Start HTTP Server as a fallback
    http.createServer(app).listen(PORT, () => {
        console.log(`HTTP Server running on http://localhost:${PORT}`);
    });
}

// Middleware
app.use(cors());
app.use(express.json());

// Validate deals array
const isDealValid = (deal) => {
    return deal.storeID !== null && deal.storeID !== "" && deal.price !== null && deal.price !== "";
};

const isNumerical = (value) => {
    return !isNaN(parseFloat(value)) && isFinite(value);
};

const hasUniqueStoreIDs = (deals) => {
    const storeIDSet = new Set();
    for (const deal of deals) {
        if (storeIDSet.has(deal.storeID)) {
            return false;
        }
        storeIDSet.add(deal.storeID);
    }
    return true;
};

const validateDealAttributes = (deals) => {
    deals.forEach(deal => {
        if (!isDealValid(deal)) {
            throw new Error("Each deal must have a non-null storeID and price.");
        }
        if (!isNumerical(deal.price)) {
            throw new Error(`Price must be a numerical value. Invalid value: ${deal.price}`);
        }
    });
};

const validateCheapestPrice = (cheapestPrice) => {
    if (!isNumerical(cheapestPrice)) {
        throw new Error(`CheapestPrice must be a numerical value. Invalid value: ${cheapestPrice}`);
    }
};

const validateDeals = (deals) => {
    if (!Array.isArray(deals) || deals.length === 0) {
        throw new Error("Deals array cannot be empty.");
    }

    validateDealAttributes(deals);

    if (!hasUniqueStoreIDs(deals)) {
        throw new Error("Duplicate storeID found.");
    }

    return deals.map(deal => ({
        storeID: deal.storeID,
        price: deal.price
    }));
};

// Validate game attributes
const validateGameAttributes = (game) => {
    const requiredAttributes = ['title', 'cheapestPrice', 'deals'];
    const invalidAttributes = requiredAttributes.filter(attr => isAttributeInvalid(game, attr));
    
    validateCheapestPrice(game.cheapestPrice);

    if (invalidAttributes.length > 0) {
        throw new Error(`Missing or empty required attributes: ${invalidAttributes.join(', ')}`);
    }
};

const isAttributeInvalid = (game, attr) => {
    // Custom validation logic for each attribute
    switch (attr) {
        case 'title':
        case 'cheapestPrice':
        case 'deals':
            return !game[attr] || game[attr] === null || game[attr] === '';
        default:
            return false;
    }
};

// Fetch and store game data from CheapShark API
const fetchAndStoreGame = async () => {
    const API_URL = process.env.CHEAPSHARK_API;
    const collection = await connectDB();

    try {
        // Fetch game data
        const response = await axios.get(API_URL);
        const gameData = response.data;

        if (!gameData || Object.keys(gameData).length === 0) {
            console.log("No valid data received from API.");
            return { error: "Invalid API response" };
        }

        // Transform the data to store only relevant fields
        const formattedGame = {
            gameID: gameData.info.gameID,
            title: gameData.info.title,
            thumb: gameData.info.thumb,
            cheapestPrice: gameData.cheapestPriceEver.price,
            deals: gameData.deals
                .filter(deal => deal.storeID != null && deal.price != null)
                .map(deal => ({
                    storeID: deal.storeID,
                    price: deal.price
            }))
        };

        // Check if the game already exists
        const existingGame = await collection.findOne({ gameID: formattedGame.gameID });

        if (existingGame) {
            console.log("Game already exists in database.");
            return { message: "Game already exists" };
        }

        // Insert into MongoDB
        const result = await collection.insertOne(formattedGame);
        console.log("Game successfully inserted:", result.insertedId);

        return { message: "Game inserted successfully!", id: result.insertedId };
    } catch (error) {
        console.error("Error fetching and storing game data:", error);
        return { error: "Failed to fetch/store game data" };
    }
};

// API Route to manually trigger data fetching
app.post('/fetch-store', async (req, res) => {
    const result = await fetchAndStoreGame();
    res.json(result);
});

// Create a new game with specified attributes
app.post('/games', async (req, res) => {
    const collection = await connectDB();
    try {
        const { gameID, title, thumb, cheapestPrice, deals } = req.body;

        // Validate game attributes
        validateGameAttributes(req.body);

        // Validate and transform the incoming data
        validateDeals(deals);

        // Check for existing game with the same gameID or title
        const existingGame = await collection.findOne({
            $or: [
                { gameID: { $ne: null, $eq: gameID } },
                { title }
            ]
        });
        
        if (existingGame) {
            throw new Error("A game with the same gameID or title already exists.");
        }

        const newGame = {
            gameID,
            title,
            thumb,
            cheapestPrice,
            deals
        };

        const result = await collection.insertOne(newGame);
        const successMessage = `Game added with ID: ${result.insertedId}`;
        console.log(successMessage);
        res.status(201).json({ message: successMessage });
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
});

// Update an existing game by ID
app.put('/games/:id', async (req, res) => {
    const collection = await connectDB();
    try {
        const { gameID, title, thumb, cheapestPrice, deals } = req.body;

        validateGameAttributes(req.body);
        validateDeals(deals);

        const gameId = new ObjectId(req.params.id);
        const existingGame = await fetchExistingGame(collection, gameId);

        const isSameGame = checkIfSameGame(existingGame, { gameID, title, thumb, cheapestPrice, deals });

        if (isSameGame) {
            throw new Error("No changes detected. Provide at least one unique update.");
        }

        const result = await updateGame(collection, gameId, { gameID, title, thumb, cheapestPrice, deals });

        if (result.modifiedCount === 0) {
            throw new Error("Game not found or no changes made.");
        }

        const successMessage = `Game updated with ID: ${req.params.id}`;
        console.log(successMessage);
        res.json({ message: successMessage });

    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
});

const fetchExistingGame = async (collection, gameId) => {
    const existingGame = await collection.findOne({ _id: gameId });
    if (!existingGame) {
        throw new Error("Game not found.");
    }
    return existingGame;
};

const checkIfSameGame = (existingGame, newGameData) => {
    return (
        existingGame.gameID === newGameData.gameID &&
        existingGame.title === newGameData.title &&
        existingGame.thumb === newGameData.thumb &&
        existingGame.cheapestPrice === newGameData.cheapestPrice &&
        JSON.stringify(existingGame.deals) === JSON.stringify(newGameData.deals)
    );
};

const updateGame = async (collection, gameId, newGameData) => {
    return await collection.updateOne(
        { _id: gameId },
        { $set: newGameData }
    );
};
// Get all games
app.get('/games', async (req, res) => {
    const collection = await connectDB();
    try {
        const games = await collection.find().toArray();
        console.log("Fetched all games");
        res.json(games);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.status(500).json({ error: "Failed to fetch games" });
    }
});

// Get a game by ID
app.get('/games/:id', async (req, res) => {
    const collection = await connectDB();
    try {
        const game = await collection.findOne({ _id: new ObjectId(req.params.id) });
        if (!game) {
            throw new Error("Game not found");
        }
        console.log(`Fetched game with ID: ${req.params.id}`);
        res.json(game);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.status(404).json({ error: error.message });
    }
});

// Delete all games
app.delete('/games', async (req, res) => {
    try {
        const collection = await connectDB();
        const result = await collection.deleteMany({});
        res.status(200).json({ message: `${result.deletedCount} games deleted successfully` });
    } catch (error) {
        console.error('Error deleting all games:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete a game by ID
app.delete('/games/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const collection = await connectDB();
        const result = await collection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Game not found' });
        }

        res.status(200).json({ message: 'Game deleted successfully' });
    } catch (error) {
        console.error('Error deleting game:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
