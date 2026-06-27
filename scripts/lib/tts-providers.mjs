/**
 * TTS providers for offline Bible audio generation.
 * Primary: xAI Grok TTS (built-in + custom cloned voices).
 * Optional: ElevenLabs (set ELEVENLABS_API_KEY + voice.elevenLabsVoiceId in voices.json).
 */

export async function synthesizeXai(text, { voiceId, language = 'en', speed = 1.0, apiKey }) {
  const key = apiKey || process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY required for xAI TTS');

  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: text.slice(0, 15000),
      voice_id: voiceId,
      language,
      speed,
      output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`xAI TTS ${res.status}: ${errText.slice(0, 300)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

export async function synthesizeElevenLabs(text, { voiceId, apiKey, modelId = 'eleven_multilingual_v2' }) {
  const key = apiKey || process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY required');
  if (!voiceId) throw new Error('elevenLabsVoiceId required on voice profile');

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text: text.slice(0, 10000),
      model_id: modelId
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS ${res.status}: ${errText.slice(0, 300)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

export async function synthesize(voiceProfile, text, opts = {}) {
  const provider = voiceProfile.provider || 'xai';
  const language = opts.language || voiceProfile.language || 'en';
  if (provider === 'elevenlabs') {
    return synthesizeElevenLabs(text, {
      voiceId: voiceProfile.elevenLabsVoiceId || voiceProfile.voiceId,
      apiKey: process.env.ELEVENLABS_API_KEY
    });
  }
  return synthesizeXai(text, {
    voiceId: voiceProfile.voiceId,
    language,
    speed: voiceProfile.speed ?? 1.0
  });
}