import express from 'express';
import { Midjourney } from 'midjourney';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();


let mjInitialized = false;

// Get current directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Configure Midjourney client
const mj = new Midjourney({
    SalaiToken: process.env.SALAI_TOKEN,
    ServerId: process.env.SERVER_ID,
    ChannelId: process.env.CHANNEL_ID,
    Debug: false,
    Ws: true,
    Timeout: 20000,
    HuggingFaceToken: process.env.HUGGING_FACE_TOKEN,
    Remix: true,
});

async function initializeMidjourney() {
    if (mjInitialized) return;
    const maxRetries = 3;
    let retryCount = 0;
    const baseDelay = 3000;

    while (retryCount < maxRetries) {
        try {
            await mj.init();
            mjInitialized = true;
            console.log('🚀 Midjourney client initialized');
            return;
        } catch (error) {
            retryCount++;
            if (error.code === 'ENOTFOUND' && retryCount < maxRetries) {
                const delay = baseDelay * retryCount;
                console.error(`DNS error. Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
}

// Now add the exception handler AFTER the function
process.on('uncaughtException', (error) => {
    if (error.code === 'ENOTFOUND' && error.hostname === 'gateway.discord.gg') {
        console.error('Critical DNS failure. Reinitializing Midjourney...');
        mjInitialized = false;
        initializeMidjourney().catch(e => console.error('Reinit failed:', e));
    } else {
        console.error('Unhandled Exception:', error);
        process.exit(1);
    }
});


// Storage configuration
const STORAGE_FILE = path.join(__dirname, 'storage', 'midjourney-data.json');
const MAX_STORAGE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_STORAGE_SIZE = 100; // Max 100 stored messages

// Ensure storage directory exists and file is properly initialized
async function initStorage() {
    try {
        await fs.mkdir(path.dirname(STORAGE_FILE), { recursive: true });
        try {
            await fs.access(STORAGE_FILE);
            // Verify the file has valid JSON content
            const content = await fs.readFile(STORAGE_FILE, 'utf8');
            if (!content.trim()) {
                throw new Error('Empty file');
            }
            JSON.parse(content);
        } catch {
            // File doesn't exist or is invalid, create fresh
            await fs.writeFile(STORAGE_FILE, JSON.stringify({ messages: {} }, null, 2));
        }
    } catch (error) {
        console.error('Storage initialization error:', error);
        throw error;
    }
}

// Load all messages from storage with proper error handling
async function loadMessages() {
    try {
        const content = await fs.readFile(STORAGE_FILE, 'utf8');
        if (!content.trim()) {
            return { messages: {} };
        }
        const data = JSON.parse(content);
        return data.messages ? data : { messages: data }; // Handle both formats
    } catch (error) {
        console.error('Error loading messages, resetting storage:', error);
        // Reset storage file if corrupted
        await fs.writeFile(STORAGE_FILE, JSON.stringify({ messages: {} }, null, 2));
        return { messages: {} };
    }
}

// Save message to storage with atomic write
async function saveMessage(id, messageData) {
    try {
        const allData = await loadMessages();
        const messages = allData.messages || allData; // Handle both formats

        // Update with new message
        messages[id] = {
            ...messageData,
            timestamp: Date.now()
        };

        // Clean up old messages
        const now = Date.now();
        const cleanedMessages = Object.fromEntries(
            Object.entries(messages)
                .filter(([_, data]) => now - (data.timestamp || now) <= MAX_STORAGE_AGE_MS)
                .slice(-MAX_STORAGE_SIZE)
        );

        // Atomic write to temporary file then rename
        const tempFile = STORAGE_FILE + '.tmp';
        await fs.writeFile(tempFile, JSON.stringify({ messages: cleanedMessages }, null, 2));
        await fs.rename(tempFile, STORAGE_FILE);
    } catch (error) {
        console.error('Error saving message:', error);
        throw error;
    }
}

// Get message from storage
async function getMessage(id) {
    try {
        const { messages } = await loadMessages();
        return messages[id] || null;
    } catch (error) {
        console.error('Error getting message:', error);
        return null;
    }
}

// Initialize storage on startup
initStorage().then(() => console.log('📦 Storage initialized'));

// Endpoint: Generate initial images
app.post('/generate-images', async (req, res) => {
    try {
        await initializeMidjourney();
        const { keyword, count } = req.body;

        // Validate required parameters
        if (!keyword || count === undefined) {
            return res.status(400).json({
                error: 'Both keyword and count parameters are required',
                example: { keyword: "delicious pancakes", count: 3 }
            });
        }

        const position = parseInt(count);
        if (isNaN(position) || position < 1 || position > 10) {
            return res.status(400).json({
                error: 'Count must be a number between 1 and 10',
                received: count
            });
        }

        try {
            const prompt = `${keyword} --iw 2 --ar 1:1 --v 6 --style raw`;
            console.log(`🚀 Generating image with prompt: ${prompt}`);

            const imagineResponse = await mj.Imagine(
                prompt,
                (uri, progress) => console.log("loading", uri, "progress", progress)
            );

            if (!imagineResponse) {
                throw new Error('MidJourney failed to respond to the imagine request');
            }

            const imageUrl = imagineResponse.uri || (imagineResponse.attachments?.[0]?.url);
            await saveMessage(imagineResponse.id, imagineResponse);

            return res.json({
                success: true,
                messageId: imagineResponse.id,
                imageUrl,
                options: imagineResponse.options?.map(o => o.label) || [],
                generatedCount: 1
            });

        } catch (error) {
            console.error(`❌ Error generating image:`, error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }

    } catch (error) {
        console.error('🚨 Endpoint error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});



async function safeCall(params, retries = 2, delay = 3000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await mj.Custom(params);
        } catch (err) {
            console.error(`\u274c Attempt ${attempt + 1} failed: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

// Endpoint: Create variation then upscale with random delays
app.post('/generate-upscale-from-variation', async (req, res) => {
    try {
        await initializeMidjourney();
        const { originalMessageId, variationNumber, delayBetweenUpscales } = req.body;

        // Validate required parameters
        if (!originalMessageId || variationNumber === undefined || variationNumber < 1 || variationNumber > 4) {
            return res.status(400).json({
                error: 'Both originalMessageId and variationNumber (1-4) are required'
            });
        }

        // Retrieve original message from storage
        const originalMessage = await getMessage(originalMessageId);
        if (!originalMessage || !originalMessage.options) {
            return res.status(404).json({
                error: 'Original message not found or has no options'
            });
        }

        // Find the requested variation
        const variationLabel = `V${variationNumber}`;
        const variationOption = originalMessage.options.find(o => o.label === variationLabel);
        if (!variationOption) {
            return res.status(404).json({
                error: `Variation ${variationLabel} not available`,
                availableOptions: originalMessage.options.map(o => o.label)
            });
        }

        console.log(`\ud83d\udfe2 Creating variation ${variationLabel}...`);
        const variationMessage = await safeCall({
            msgId: originalMessage.id,
            flags: originalMessage.flags,
            customId: variationOption.custom,
            loading: (uri, progress) => console.log(`[Variation] loading: ${progress} - ${uri}`)
        });

        if (!variationMessage || !variationMessage.options) {
            return res.status(500).json({
                error: 'Failed to create variation',
                details: variationMessage ? 'No options available' : 'No response from Midjourney'
            });
        }

        await saveMessage(variationMessage.id, variationMessage);
        console.log(`\u2705 Variation created successfully`);

        const upscaledResults = [];
        const upscaleLabels = ['U1', 'U2'];

        for (const label of upscaleLabels) {
            const delayMs = delayBetweenUpscales
                ? Math.max(10000, Math.min(parseInt(delayBetweenUpscales) || 10000, 15000))
                : Math.floor(Math.random() * 5000) + 10000;

            console.log(`\u23f3 Waiting ${(delayMs / 1000).toFixed(1)} seconds before next upscale...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));

            const upscaleOption = variationMessage.options.find(o => o.label === label);
            if (!upscaleOption) {
                console.warn(`\u26a0\ufe0f No option found for ${label}`);
                continue;
            }

            console.log(`\ud83d\udfe2 Starting upscale for ${label}...`);
            const upscale = await safeCall({
                msgId: variationMessage.id,
                flags: variationMessage.flags,
                customId: upscaleOption.custom,
                loading: (uri, progress) => console.log(`[${label}] loading: ${progress} - ${uri}`)
            });

            if (!upscale) {
                console.warn(`\u274c Upscale failed for ${label}`);
                continue;
            }

            const imageUrl = upscale.uri || (upscale.attachments?.[0]?.url);
            if (!imageUrl) {
                console.warn(`\u26a0\ufe0f No image URL found for ${label}`);
                continue;
            }

            console.log(`\u2705 Upscale completed for ${label}: ${imageUrl}`);
            upscaledResults.push({
                label,
                imageUrl,
                upscaleNumber: parseInt(label.substring(1))
            });
        }

        return res.json({
            status: 'completed',
            originalMessageId,
            variationLabel,
            variationMessageId: variationMessage.id,
            upscaledImages: upscaledResults,
            actualDelaysUsed: {
                betweenUpscales: delayBetweenUpscales
                    ? `${delayBetweenUpscales}ms (clamped to 10-15s)`
                    : `random 10-15s`
            }
        });

    } catch (error) {
        console.error('\ud83d\udea8 /generate-upscale-from-variation error:', error);
        return res.status(500).json({
            error: error.message,
            ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
        });
    }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});