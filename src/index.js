import { Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://testing-g5wrpk39.livekit.cloud';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ROOM_NAME = process.env.ROOM_NAME || 'tech-world';
const BOT_IDENTITY = 'bot-claude';
const BOT_NAME = 'Claude';

// System prompt for the bot
const SYSTEM_PROMPT = `You are Clawd, a friendly AI coding tutor in Tech World - an educational multiplayer game where players learn programming together.

Your personality:
- Warm, encouraging, and patient
- Use casual, friendly language
- Keep responses concise (2-3 sentences for simple questions, more for complex topics)
- Use code examples when helpful, formatted with backticks

Your role:
- Help players learn Dart and Flutter
- Explain programming concepts clearly
- Give hints on coding challenges (guide, don't give full solutions)
- Celebrate progress and encourage exploration

Remember: You're in a game world! Keep things fun and engaging.`;

// Store conversation history per user (simple in-memory store)
const conversationHistory = new Map();

// Initialize Anthropic client
let anthropic;

async function generateToken() {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: BOT_IDENTITY,
    name: BOT_NAME,
    ttl: '24h',
  });

  at.addGrant({
    roomJoin: true,
    room: ROOM_NAME,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  return await at.toJwt();
}

async function callClaude(userId, userMessage) {
  // Get or create conversation history for this user
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  // Add user message to history
  history.push({ role: 'user', content: userMessage });

  // Keep only last 20 messages to avoid token limits
  while (history.length > 20) {
    history.shift();
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const assistantMessage = response.content[0].text;

    // Add assistant response to history
    history.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
  } catch (err) {
    console.error('Claude API error:', err.message);
    // Remove the failed user message from history
    history.pop();
    return "Oops! I'm having trouble thinking right now. Try again in a moment?";
  }
}

async function main() {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error('Error: LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
    process.exit(1);
  }

  if (!ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY must be set');
    process.exit(1);
  }

  // Initialize Anthropic client
  anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  console.log(`Bot service starting...`);
  console.log(`  LiveKit URL: ${LIVEKIT_URL}`);
  console.log(`  Room: ${ROOM_NAME}`);
  console.log(`  Bot identity: ${BOT_IDENTITY}`);
  console.log(`  Claude API: configured`);

  const room = new Room();

  // Handle participant connected
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log(`Participant connected: ${participant.identity} (${participant.name})`);
  });

  // Handle participant disconnected
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    console.log(`Participant disconnected: ${participant.identity}`);
    // Optionally clear their conversation history
    // conversationHistory.delete(participant.identity);
  });

  // Handle data received
  room.on(RoomEvent.DataReceived, async (data, participant, kind, topic) => {
    const senderId = participant?.identity || 'server';
    const text = new TextDecoder().decode(data);
    console.log(`Data received from ${senderId}, topic: ${topic || 'none'}`);

    // Parse the message
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      console.log('  (not JSON, ignoring)');
      return;
    }

    // Handle ping messages (for testing connectivity)
    if (topic === 'ping') {
      const response = {
        type: 'pong',
        originalMessage: message,
        botId: BOT_IDENTITY,
        timestamp: Date.now(),
      };

      const responseData = new TextEncoder().encode(JSON.stringify(response));
      const destinationIdentities = participant ? [participant.identity] : undefined;

      await room.localParticipant.publishData(responseData, {
        reliable: true,
        topic: 'pong',
        destinationIdentities,
      });

      console.log(`  Sent pong to ${senderId}`);
      return;
    }

    // Handle chat messages
    if (topic === 'chat' && message.text) {
      console.log(`  Chat message: "${message.text.substring(0, 50)}${message.text.length > 50 ? '...' : ''}"`);

      // Call Claude API
      const claudeResponse = await callClaude(senderId, message.text);
      console.log(`  Claude response: "${claudeResponse.substring(0, 50)}${claudeResponse.length > 50 ? '...' : ''}"`);

      // Send response back
      const response = {
        type: 'chat-response',
        messageId: message.id,
        text: claudeResponse,
        botId: BOT_IDENTITY,
        timestamp: Date.now(),
      };

      const responseData = new TextEncoder().encode(JSON.stringify(response));
      const destinationIdentities = participant ? [participant.identity] : undefined;

      await room.localParticipant.publishData(responseData, {
        reliable: true,
        topic: 'chat-response',
        destinationIdentities,
      });

      console.log(`  Sent chat response to ${senderId}`);
    }
  });

  // Handle disconnection
  room.on(RoomEvent.Disconnected, (reason) => {
    console.log(`Disconnected from room: ${reason}`);
    // Attempt reconnection after delay
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      connectToRoom();
    }, 5000);
  });

  async function connectToRoom() {
    try {
      const freshToken = await generateToken();
      await room.connect(LIVEKIT_URL, freshToken, {
        autoSubscribe: true,
      });
      console.log(`Connected to room "${ROOM_NAME}" as ${BOT_IDENTITY}`);
      console.log(`Local participant SID: ${room.localParticipant.sid}`);

      // List existing participants
      const participants = room.remoteParticipants;
      console.log(`Current participants in room: ${participants.size}`);
      for (const [identity, p] of participants) {
        console.log(`  - ${identity} (${p.name})`);
      }
    } catch (err) {
      console.error('Failed to connect:', err.message);
      // Retry after delay
      setTimeout(connectToRoom, 5000);
    }
  }

  await connectToRoom();

  // Keep the process running
  console.log('Bot service running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
