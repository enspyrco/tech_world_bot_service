import { Room, RoomEvent, DataPacketKind } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import 'dotenv/config';

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://testing-g5wrpk39.livekit.cloud';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ROOM_NAME = process.env.ROOM_NAME || 'tech-world';
const BOT_IDENTITY = 'bot-claude';
const BOT_NAME = 'Claude';

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

async function main() {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error('Error: LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
    process.exit(1);
  }

  console.log(`Bot service starting...`);
  console.log(`  LiveKit URL: ${LIVEKIT_URL}`);
  console.log(`  Room: ${ROOM_NAME}`);
  console.log(`  Bot identity: ${BOT_IDENTITY}`);

  const token = await generateToken();
  const room = new Room();

  // Handle participant connected
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log(`Participant connected: ${participant.identity} (${participant.name})`);
  });

  // Handle participant disconnected
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    console.log(`Participant disconnected: ${participant.identity}`);
  });

  // Handle data received - echo it back
  room.on(RoomEvent.DataReceived, async (data, participant, kind, topic) => {
    const senderId = participant?.identity || 'server';
    const text = new TextDecoder().decode(data);
    console.log(`Data received from ${senderId}, topic: ${topic || 'none'}`);
    console.log(`  Content: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

    // Parse the message
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      console.log('  (not JSON, ignoring)');
      return;
    }

    // Echo back with acknowledgement
    if (topic === 'chat' || topic === 'ping') {
      const response = {
        type: 'echo',
        originalMessage: message,
        botId: BOT_IDENTITY,
        timestamp: Date.now(),
      };

      const responseData = new TextEncoder().encode(JSON.stringify(response));

      // Send response back to the sender (or broadcast if no specific sender)
      const destinationIdentities = participant ? [participant.identity] : undefined;

      await room.localParticipant.publishData(responseData, {
        reliable: true,
        topic: topic === 'ping' ? 'pong' : 'chat-response',
        destinationIdentities,
      });

      console.log(`  Echoed response to ${senderId}`);
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
