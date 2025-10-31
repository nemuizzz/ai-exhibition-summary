import { spawn } from 'child_process';
import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import OpenAI from 'openai';
import os from 'os';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function isSilentWav(filePath) {
  try {
    const b = await fs.promises.readFile(filePath);
    if (b.length < 100) return true;
    // 44バイト以降にPCMデータがある前提（ffmpegで生成）
    let offset = 44;
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
      offset = 44;
    }
    let sumSquares = 0;
    let count = 0;
    for (let i = offset; i + 1 < b.length; i += 2) {
      const sample = b.readInt16LE(i);
      sumSquares += sample * sample;
      count++;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, count));
    return rms < 600; // 閾値（少し緩めに調整）
  } catch (_) {
    return false;
  }
}

async function summarizeAndPrint(text, socket) {
  try {
    const sys = `あなたは商談・来場ヒアリングの要約AIです。以下の日本語項目のみをキーとする有効なJSONだけを返してください。
ポリシー:
- 各項目は可能な限り具体的に、箇条書き(•不要・行頭ハイフンなし)で3〜7点まで展開可。
- 数値・期間・規模・固有名詞（会社名・部署・役職・製品名など）はできる限り明記。
- あいまいな推測はしない。情報がなければ空文字にする。
- 文章は簡潔で一文短め。主語が明確になるように整形。
- 予算額は金額が判明する場合のみ、通貨記号（例: ¥, $, 円）＋半角数字で正規化（例: "¥3,000,000"）。不明なら空文字。
{
  "timestamp": "<ISO8601>",
  "来場目的": "<例: DX推進のための情報収集/パートナー企業の探索 など>",
  "業務の課題": "<例: 業務効率の低下/データ連携が不十分 など>",
  "検討サービス": ["<以下のいずれか: AI開発, 生成AI導入支援, 業務改革支援, 新規事業開発, 未定>"] ,
  "導入予定時期": "<以下のいずれか: 導入中, すぐにでも導入したい, 3か月後〜半年後, 未定>",
  "予算確保の状況": "<例: 予算確保済み/検討中/申請予定 など>",
  "予算額": "<例: ¥3,000,000 のように通貨+半角数字。なければ空>",
  "具体的に依頼したい内容": "<例: 自社データを活用した生成AIのPoC支援を依頼したい など>",
  "その他": "<補足や連絡事項など>"
}`;
    const user = `会話テキスト:\n${text}\n---\n上記スキーマの有効なJSONのみを返してください。各項目は可能な限り具体的に、必要なら箇条書きで3〜7点まで展開してください。数値・期間・規模・固有名詞は積極的に明記し、不明なら空文字にしてください。`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.1
    });

    const json = resp.choices[0].message.content.trim();
    console.log('\n=== Structured Summary ===\n', json, '\n==========================\n');
    // クライアントへ送信 + 呼び出し元へ返却
    try {
      const payload = JSON.parse(json);
      socket.send(JSON.stringify({ type: 'summary', data: payload }));
      // 追加ログ（1行）
      const topic = payload.topic || '';
      const purpose = payload['来場目的'] || '';
      const when = payload['導入予定時期'] || '';
      const budget = payload['予算額'] || '';
      console.log(`[要約] ts=${payload.timestamp || ''} topic=${topic} 来場目的=${purpose} 導入予定時期=${when} 予算額=${budget}`);
      return payload;
    } catch (_) {
      socket.send(JSON.stringify({ type: 'summary_raw', data: json }));
      console.log(`[要約(raw)] ${json}`);
      return null;
    }
  } catch (e) {
    console.error('Summarize error', e?.response?.data || e);
    return null;
  }
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket) => {
  console.log('Client connected');

  // 接続ごとのバッファと更新タイムスタンプ
  let bufferText = '';
  let totalTranscript = '';
  let liveAccumulated = '';
  let lastUpdate = Date.now();
  let lastSummary = null;
  const SHOULD_UPDATE = () => {
    const enoughChars = bufferText.length >= 400;
    const enoughTime = (Date.now() - lastUpdate) >= 15000;
    return enoughChars || enoughTime;
  };
  // 10秒ごとに要約（バッファがあれば）
  const SUMMARY_INTERVAL_MS = 10000;
  const summaryTimer = setInterval(async () => {
    try {
      const target = [bufferText, liveAccumulated].filter(Boolean).join(' ').trim();
      const len = target.length;
      console.log(`[summary-tick] targetLen=${len}`);
      if (len > 0) {
        lastUpdate = Date.now();
        const s = await summarizeAndPrint(target, socket);
        if (s) lastSummary = s;
        bufferText = '';
      } else {
        // skip
      }
    } catch (e) {
      console.error('Periodic summarize error', e?.message || e);
    }
  }, SUMMARY_INTERVAL_MS);

  // OpenAI Realtime（遅延接続：録音開始時のみ）
  const rtModel = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
  const transcribeModel = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
  let rt = null;
  const sendRT = (obj) => { if (rt && rt.readyState === 1) rt.send(JSON.stringify(obj)); };
  const openRealtime = () => {
    if (rt && (rt.readyState === 0 || rt.readyState === 1)) return; // connecting/open
    rt = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(rtModel)}`,
      'realtime',
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        },
        perMessageDeflate: false
      }
    );
    rt.on('open', () => {
      sendRT({
        type: 'transcription_session.update',
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: transcribeModel,
          prompt: '日本語中心の会話。人名・社名・製品名を正確に。',
          language: 'ja'
        },
        turn_detection: {
          type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700
        },
        input_audio_noise_reduction: { type: 'near_field' },
        include: []
      });
    });
    rt.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const t = msg.type;
        if (t === 'conversation.item.input_audio_transcription.delta') {
          const delta = msg.delta || '';
          if (delta) { liveAccumulated = delta; socket.send(JSON.stringify({ type: 'transcript_delta', text: delta })); }
        }
        if (t === 'conversation.item.input_audio_transcription.completed') {
          const transcript = msg.transcript || '';
          if (transcript) {
            socket.send(JSON.stringify({ type: 'transcript', text: transcript }));
            bufferText += (bufferText ? ' ' : '') + transcript;
            totalTranscript += (totalTranscript ? ' ' : '') + transcript;
            liveAccumulated = '';
          }
        }
      } catch (_) { }
    });
    rt.on('error', (e) => console.error('RT error', e.message || e));
    rt.on('unexpected-response', (req, res) => {
      console.error('RT unexpected-response status', res.statusCode);
      res.on('data', (d) => process.stderr.write(String(d)));
    });
    rt.on('close', (code, reason) => { console.log('RT closed', code, reason?.toString?.()); });
  };
  const closeRealtime = () => { try { rt?.close(); } catch (_) { } rt = null; };

  socket.on('message', async (data) => {
    // 先頭行(JSON) + '\n' + 本体
    const u8 = new Uint8Array(data);
    const nl = u8.indexOf(10);
    if (nl < 0) return;
    const header = JSON.parse(new TextDecoder().decode(u8.slice(0, nl)));
    const body = u8.slice(nl + 1);
    // Realtimeの遅延接続制御
    if (header.type === 'realtime_open') { openRealtime(); return; }
    if (header.type === 'realtime_close') { closeRealtime(); return; }
    // フロントからの確定文字起こしをサーバーに反映
    if (header.type === 'transcript_push' && header.text) {
      const text = String(header.text).trim();
      if (text) {
        bufferText += (bufferText ? ' ' : '') + text;
        totalTranscript += (totalTranscript ? ' ' : '') + text;
        console.log(`[push] +${text.length} chars, bufferLen=${bufferText.length}`);
      }
      return;
    }
    // 停止時の最終全量（精度重視）
    if (header.type === 'final') {
      try {
        const inExt = (header.mime || '').includes('webm') ? 'webm'
          : (header.mime || '').includes('mp4') ? 'mp4'
            : (header.mime || '').includes('ogg') ? 'ogg'
              : (header.mime || '').includes('wav') ? 'wav'
                : 'dat';
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const tmpIn = path.join(os.tmpdir(), `rt-final-${id}.${inExt}`);
        const tmpWav = path.join(os.tmpdir(), `rt-final-${id}.wav`);
        await fs.promises.writeFile(tmpIn, Buffer.from(body));
        const ffmpegStderr = [];
        await new Promise((resolve, reject) => {
          const p = spawn('ffmpeg', [
            '-y',
            '-loglevel', 'error',
            '-i', tmpIn,
            '-ac', '1',
            '-ar', '16000',
            '-acodec', 'pcm_s16le',
            '-f', 'wav',
            tmpWav
          ]);
          p.stderr.on('data', (d) => ffmpegStderr.push(String(d)));
          p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${ffmpegStderr.join('')}`)));
          p.on('error', reject);
        });
        // 無音でも最終は試す（長尺で拾えることが多い）
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpWav),
          model: 'whisper-1',
          language: 'ja'
        });
        const text = transcription.text?.trim();
        if (text) {
          bufferText = text; // 最終文字起こしで置き換え
          const s = await summarizeAndPrint(bufferText, socket);
          if (s) lastSummary = s;
          bufferText = '';
        }
        fs.promises.unlink(tmpIn).catch(() => { });
        fs.promises.unlink(tmpWav).catch(() => { });
      } catch (e) {
        console.error('Final transcription error', e?.response?.data || e.message);
      }
      return;
    }

    // クライアントから直接WAVチャンクが来る場合（推奨）
    if (header.type === 'wav_chunk') {
      try {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const tmpWav = path.join(os.tmpdir(), `rt-chunk-${id}.wav`);
        await fs.promises.writeFile(tmpWav, Buffer.from(body));
        if (await isSilentWav(tmpWav)) {
          fs.promises.unlink(tmpWav).catch(() => { });
          return;
        }
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpWav),
          model: 'whisper-1',
          language: 'ja'
        });
        const text = transcription.text?.trim();
        if (text) {
          process.stdout.write(text + '\n');
          socket.send(JSON.stringify({ type: 'transcript', text }));
          bufferText += (bufferText ? ' ' : '') + text;
          totalTranscript += (totalTranscript ? ' ' : '') + text;
        }
        fs.promises.unlink(tmpWav).catch(() => { });
      } catch (e) {
        console.error('WAV chunk error', e?.response?.data || e.message);
      }
      return;
    }

    // 停止時の最終WAV
    if (header.type === 'final_wav') {
      try {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const tmpWav = path.join(os.tmpdir(), `rt-final-${id}.wav`);
        await fs.promises.writeFile(tmpWav, Buffer.from(body));
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpWav),
          model: 'whisper-1',
          language: 'ja'
        });
        const text = transcription.text?.trim();
        if (text) {
          bufferText = text;
          const s = await summarizeAndPrint(bufferText, socket);
          if (s) lastSummary = s;
          bufferText = '';
        }
        fs.promises.unlink(tmpWav).catch(() => { });
      } catch (e) {
        console.error('Final WAV error', e?.response?.data || e.message);
      }
      return;
    }

    // PCM16ダイレクトチャンク（推奨）
    if (header.type === 'pcm16_chunk') {
      try {
        // OpenAI Realtimeへappend
        const b64 = Buffer.from(body).toString('base64');
        await sendRT({ type: 'input_audio_buffer.append', audio: b64 });
      } catch (e) {
        console.error('PCM16 chunk error', e.message || e);
      }
      return;
    }

    // 停止時の最終PCM16
    if (header.type === 'final_pcm16') {
      try {
        const b64 = Buffer.from(body).toString('base64');
        sendRT({ type: 'input_audio_buffer.append', audio: b64 });
        sendRT({ type: 'input_audio_buffer.commit' });
      } catch (e) {
        console.error('Final PCM16 error', e.message || e);
      }
      return;
    }

    // 旧フォーマット 'chunk' は未対応（無視）
    if (header.type === 'chunk') return;
  });

  function formatSlackMessage(s) {
    if (!s || typeof s !== 'object') return '要約データなし';
    const val = (k) => s[k] ?? '';
    const arr = (k) => Array.isArray(s[k]) ? s[k].join('、') : (s[k] ?? '');
    const lines = [
      `timestamp: ${val('timestamp')}`,
      `来場目的: ${val('来場目的')}`,
      `業務の課題: ${val('業務の課題')}`,
      `検討サービス: ${arr('検討サービス')}`,
      `導入予定時期: ${val('導入予定時期')}`,
      `予算確保の状況: ${val('予算確保の状況')}`,
      `予算額: ${val('予算額')}`,
      `具体的に依頼したい内容: ${val('具体的に依頼したい内容')}`,
      `その他: ${val('その他')}`
    ];
    if (!val('来場目的') && (s.summary || s.topic)) {
      lines.push(`topic: ${s.topic ?? ''}`);
      lines.push(`summary: ${s.summary ?? ''}`);
    }
    return lines.join('\n');
  }

  function buildSlackBlocks(s) {
    if (!s || typeof s !== 'object') return null;
    const val = (k) => s[k] ?? '';
    const arr = (k) => Array.isArray(s[k]) ? s[k].join('、') : (s[k] ?? '');
    const fields = [];
    const pushField = (label, content) => {
      if (content && String(content).trim()) {
        fields.push({ type: 'mrkdwn', text: `*${label}*\n${content}` });
      }
    };
    pushField('来場目的', val('来場目的'));
    pushField('業務の課題', val('業務の課題'));
    pushField('検討サービス', arr('検討サービス'));
    pushField('導入予定時期', val('導入予定時期'));
    pushField('予算確保の状況', val('予算確保の状況'));
    pushField('予算額', val('予算額'));
    pushField('具体的に依頼したい内容', val('具体的に依頼したい内容'));
    pushField('その他', val('その他'));
    // 旧スキーマfallback
    if (fields.length === 0 && (s.summary || s.topic)) {
      pushField('トピック', s.topic ?? '');
      pushField('要約', s.summary ?? '');
    }
    const headerText = s.topic ? `要約: ${s.topic}` : '要約';
    const tsLine = s.timestamp ? { type: 'context', elements: [{ type: 'mrkdwn', text: `timestamp: ${s.timestamp}` }] } : null;
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
      { type: 'divider' },
      { type: 'section', fields }
    ];
    if (tsLine) blocks.push(tsLine);
    return blocks;
  }

  socket.on('close', async () => {
    try { rt.close(); } catch (_) { }
    try {
      clearInterval(summaryTimer);
      // 停止時は必ず要約（全体のテキストで最終要約）
      const finalTarget = (totalTranscript && totalTranscript.trim()) ? totalTranscript : bufferText;
      if (finalTarget && finalTarget.trim()) {
        lastUpdate = Date.now();
        const s = await summarizeAndPrint(finalTarget, socket);
        if (s) lastSummary = s;
        bufferText = '';
      }
      const url = process.env.SLACK_WEBHOOK_URL;
      if (!url) {
        console.log('Slack webhook not configured');
        return;
      }
      if (lastSummary) {
        const fallback = formatSlackMessage(lastSummary);
        const blocks = buildSlackBlocks(lastSummary);
        const payload = blocks ? { text: fallback, blocks } : { text: fallback };
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) console.error('Slack post failed', await res.text());
        else console.log('Slack posted');
      }
    } catch (e) {
      console.error('Slack post error', e?.message || e);
    }
  });
});

// Realtime WebRTC用: エフェメラルセッション発行HTTPサーバー
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const mime = (p) => {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
};

const httpServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

  // 静的配信（GET/HEAD）
  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      let urlPath = req.url || '/';
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
      const filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(urlPath.replace(/^\/+/, ''))));
      if (!filePath.startsWith(PUBLIC_DIR)) { res.statusCode = 403; res.end('forbidden'); return; }
      const st = await fs.promises.stat(filePath).catch(() => null);
      if (!st || !st.isFile()) { res.statusCode = 404; res.end('not found'); return; }
      res.statusCode = 200;
      res.setHeader('Content-Type', mime(filePath));
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(filePath).pipe(res);
      return;
    } catch (e) {
      res.statusCode = 500; res.end('error'); return;
    }
  }

  if (req.method === 'POST' && req.url === '/session') {
    try {
      const rtModel = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
      const transcribeModel = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => data += c);
        req.on('end', () => resolve(data || '{}'));
      });
      const reqJson = JSON.parse(body);
      const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'realtime=v1'
        },
        body: JSON.stringify({
          model: reqJson.model || rtModel,
          input_audio_format: 'pcm16',
          input_audio_transcription: {
            model: transcribeModel,
            language: 'ja'
          },
          turn_detection: {
            type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700
          },
          input_audio_noise_reduction: { type: 'near_field' }
        })
      });
      const json = await resp.json();
      console.log('[session] status', resp.status);
      res.statusCode = resp.ok ? 200 : 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(json));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e?.message || 'session error' }));
    }
    return;
  }
  res.statusCode = 404; res.end('not found');
});
httpServer.on('upgrade', (req, socket, head) => {
  try {
    if (req.url === '/stream') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws);
      });
    } else {
      socket.destroy();
    }
  } catch (_) {
    try { socket.destroy(); } catch (_) { }
  }
});
httpServer.listen(8787, () => console.log('App listening http://localhost:8787'));

