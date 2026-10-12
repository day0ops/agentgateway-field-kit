#!/usr/bin/env bun
/**
 * Manual, interactive tester for the openai-realtime-voice usecase
 * (config/usecases/enterprise/routing/audio/openai-realtime-voice.yaml).
 *
 * Not wired into `agw usecase test` - that runner asserts deterministic
 * request/response steps, and a live voice turn has no pass/fail condition and
 * needs a human at a mic. This is a standalone sanity-check tool instead.
 *
 * Two input modes:
 *   - default: push-to-talk over your mic (requires `sox` - brew install sox)
 *   - --file <wav>: send a prerecorded mono PCM16 WAV instead (single turn, no sox needed)
 *
 * Either way, the response is spoken back via `afplay` (macOS only, matches the
 * playback mechanism openai-audio-tts.yaml's test already relies on).
 *
 * Usage:
 *   bun scripts/realtime-voice-demo.js
 *   bun scripts/realtime-voice-demo.js --file config/test-assets/what-is-kubernetes.wav
 *   bun scripts/realtime-voice-demo.js --host localhost --port 8080
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDITION_GATEWAY_NAME } from '../src/lib/editions.js';
import { UseCaseTestRunner } from '../src/lib/usecase-tests.js';

const OUTPUT_SAMPLE_RATE = 24000;

function parseArgs(argv) {
  const args = {
    namespace: process.env.AGENTGATEWAY_NAMESPACE || 'agentgateway-system',
    gatewayName: EDITION_GATEWAY_NAME.enterprise,
    port: 8080,
    path: '/openai/v1/realtime',
    model: 'gpt-realtime-1.5',
    voice: 'alloy',
    instructions: 'You are a concise, friendly voice assistant.',
    host: null,
    file: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split('=');
    const next = () => inlineValue ?? argv[++i];
    switch (flag) {
      case '--namespace':
        args.namespace = next();
        break;
      case '--gateway-name':
        args.gatewayName = next();
        break;
      case '--port':
        args.port = Number(next());
        break;
      case '--path':
        args.path = next();
        break;
      case '--model':
        args.model = next();
        break;
      case '--voice':
        args.voice = next();
        break;
      case '--instructions':
        args.instructions = next();
        break;
      case '--host':
        args.host = next();
        break;
      case '--file':
        args.file = next();
        break;
      case '--help':
        printUsageAndExit();
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        printUsageAndExit(1);
    }
  }
  return args;
}

function printUsageAndExit(code = 0) {
  console.log(`
Usage: bun scripts/realtime-voice-demo.js [options]

  --file <path>         Send a prerecorded mono 16-bit PCM WAV instead of live mic (one turn, exits after playback)
  --host <host>         Gateway host/IP (skips the kubectl LoadBalancer lookup)
  --port <port>         Gateway port (default: 8080)
  --namespace <ns>      Gateway namespace (default: agentgateway-system)
  --gateway-name <name> Gateway Service name (default: ${EDITION_GATEWAY_NAME.enterprise})
  --path <path>         Route path for the realtime backend (default: /openai/v1/realtime)
  --model <model>       Realtime model (default: gpt-realtime-1.5)
  --voice <voice>       Output voice (default: alloy)
  --instructions <text> System instructions for the session
`);
  process.exit(code);
}

/** Walk RIFF subchunks to find fmt/data - tolerates extra chunks (e.g. a filler chunk) before data. */
function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length && (!fmt || !data)) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        numChannels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(chunkStart, chunkStart + chunkSize);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!fmt || !data) throw new Error('WAV file is missing a fmt or data chunk');
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error('Only 16-bit PCM WAV files are supported');
  }
  if (fmt.numChannels !== 1) {
    throw new Error(
      'Only mono WAV files are supported - downmix first (e.g. sox in.wav -c 1 out.wav)'
    );
  }
  return { sampleRate: fmt.sampleRate, pcm: data };
}

function pcm16ToWav(buffer, sampleRate) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + buffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(buffer.length, 40);
  return Buffer.concat([header, buffer]);
}

async function playWav(buffer, sampleRate) {
  const path = join(tmpdir(), `realtime-response-${Date.now()}.wav`);
  writeFileSync(path, pcm16ToWav(buffer, sampleRate));
  const proc = Bun.spawn(['afplay', path], { stdout: 'ignore', stderr: 'ignore' });
  await proc.exited;
}

function sessionUpdateEvent(args, inputSampleRate) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: args.model,
      output_modalities: ['audio'],
      instructions: args.instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: inputSampleRate },
          // Manual turn control: this script decides when a turn ends (either the
          // whole --file has been sent, or the user presses Enter), rather than
          // relying on server-side silence detection timed against a recorded buffer.
          turn_detection: null,
        },
        output: {
          format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE },
          voice: args.voice,
        },
      },
    },
  };
}

async function connect(args) {
  const host =
    args.host || (await UseCaseTestRunner.getGatewayAddress(args.namespace, args.gatewayName));
  const url = `ws://${host}:${args.port}${args.path}?model=${encodeURIComponent(args.model)}`;
  console.log(`Connecting to ${url} ...`);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener(
      'error',
      e => reject(new Error(`WebSocket connect failed: ${e.message || e}`)),
      {
        once: true,
      }
    );
  });
  console.log('Connected.');
  return ws;
}

/** Drives one request/response turn and resolves once response.done fires. */
function runTurn(ws) {
  let audioChunks = [];
  return new Promise((resolve, reject) => {
    const onMessage = event => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'response.output_audio_transcript.delta':
          process.stdout.write(msg.delta);
          break;
        case 'response.output_audio.delta':
          audioChunks.push(Buffer.from(msg.delta, 'base64'));
          break;
        case 'response.done': {
          ws.removeEventListener('message', onMessage);
          console.log();
          const usage = msg.response?.usage;
          if (usage) {
            console.log(
              `  (usage: ${usage.input_tokens ?? '?'} in / ${usage.output_tokens ?? '?'} out tokens)`
            );
          }
          resolve(Buffer.concat(audioChunks));
          break;
        }
        case 'error':
          ws.removeEventListener('message', onMessage);
          reject(new Error(msg.error?.message || JSON.stringify(msg)));
          break;
        default:
        // session.created / session.updated / input_audio_buffer.* - ignored
      }
    };
    ws.addEventListener('message', onMessage);
  });
}

async function sendFileTurn(ws, args) {
  const { sampleRate, pcm } = parseWav(readFileSync(args.file));
  ws.send(JSON.stringify(sessionUpdateEvent(args, sampleRate)));

  const CHUNK_SIZE = 32 * 1024;
  for (let i = 0; i < pcm.length; i += CHUNK_SIZE) {
    ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm.subarray(i, i + CHUNK_SIZE).toString('base64'),
      })
    );
  }
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

  console.log(`Sent ${args.file} (${sampleRate}Hz). Waiting for response...`);
  const turnPromise = runTurn(ws);
  ws.send(JSON.stringify({ type: 'response.create' }));
  const audio = await turnPromise;
  if (audio.length > 0) await playWav(audio, OUTPUT_SAMPLE_RATE);
}

async function recordMic() {
  const MIC_SAMPLE_RATE = 24000;
  const proc = Bun.spawn(
    [
      'sox',
      '-d',
      '-t',
      'raw',
      '-r',
      String(MIC_SAMPLE_RATE),
      '-e',
      'signed',
      '-b',
      '16',
      '-c',
      '1',
      '-q',
      '-',
    ],
    { stdout: 'pipe', stderr: 'ignore' }
  );
  return { proc, sampleRate: MIC_SAMPLE_RATE };
}

async function liveMicLoop(ws, args) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = prompt => new Promise(resolve => rl.question(prompt, resolve));

  console.log('Push-to-talk: press Enter to start talking, Enter again to stop. Ctrl+C to quit.');
  for (;;) {
    await ask('\nPress Enter to start recording...');
    const { proc: sox, sampleRate } = await recordMic();
    ws.send(JSON.stringify(sessionUpdateEvent(args, sampleRate)));

    const sendLoop = (async () => {
      for await (const chunk of sox.stdout) {
        ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(chunk).toString('base64'),
          })
        );
      }
    })();

    await ask('Recording... press Enter to stop.');
    sox.kill();
    await sendLoop;
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    console.log('Waiting for response...');
    const turnPromise = runTurn(ws);
    ws.send(JSON.stringify({ type: 'response.create' }));
    const audio = await turnPromise;
    if (audio.length > 0) await playWav(audio, OUTPUT_SAMPLE_RATE);
  }
}

const args = parseArgs(process.argv.slice(2));

let ws;
try {
  ws = await connect(args);
  if (args.file) {
    await sendFileTurn(ws, args);
  } else {
    await liveMicLoop(ws, args);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  if (err.message?.includes('ENOENT') || /sox/i.test(err.message || '')) {
    console.error('Is sox installed? Try: brew install sox  (or use --file <path> instead)');
  }
  process.exit(1);
} finally {
  ws?.close();
}
