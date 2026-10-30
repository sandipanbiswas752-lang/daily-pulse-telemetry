// api/daily-cron.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const DAILY_SYSTEM_INSTRUCTION = `You are a strict, perceptive midnight accountability coach for a 3rd-year B.Tech ECE student commuting 40 mins each way.

### Weekly Routine & Focus Windows
- Mondays: Morning tuition batch (7:00 AM - 9:30 AM), then college.
- Tuesdays (Heavy Drain): Morning tuition (7:30 AM - 9:15 AM), college, evening tuition (6:00 PM - 9:30 PM).
- Wednesdays (Focus Window): College ends at 2:00 PM. No evening tuitions. Primary C++ and IoT learning block.
- Thursdays (Heavy Drain): Morning tuition (7:30 AM - 9:30 AM), college, evening tuition (4:00 PM - 9:00 PM).
- Fridays (Focus Window): College ends at 5:00 PM. No evening tuitions. Primary CapCut video editing block.
- Saturdays: Morning tuition (8:00 AM - 10:00 AM), afternoon tuition (4:00 PM - 9:30 PM). Midday is open for hardware projects.
- Sundays: Completely open for recovery and deep work.

### Output Format Rules (STRICT)
1. Write a brief, sharp 2-sentence midnight review of today's logs:
   - Point out directly if I missed a scheduled focus block, forgot to log meals/sleep, left To-Do items unfinished, or logged an excuse ('reflection').
2. Follow it on a new line with "🎯 Tomorrow's Micro-Goal:" and 1 specific, realistic micro-goal tailored to tomorrow's exact weekday schedule.
3. Use plain text and simple emojis only.`;

export default async function handler(req, res) {
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized cron trigger' });
  }

  try {
    const now = new Date();
    const logicalNow = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    const istDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(logicalNow);

    const startOfTodayIST = `${istDateStr}T00:00:00+05:30`;

    const todayWeekday = logicalNow.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
    });
    const tomorrowWeekday = new Date(logicalNow.getTime() + 24 * 60 * 60 * 1000).toLocaleDateString(
      'en-IN',
      { timeZone: 'Asia/Kolkata', weekday: 'long' }
    );

    const { data: logs, error: dbError } = await supabase
      .from('daily_logs')
      .select('created_at, event_type, notes')
      .not('event_type', 'in', '("todo_pending","todo_done","weekly_summary")')
      .gte('created_at', startOfTodayIST)
      .order('created_at', { ascending: true });

    if (dbError) {
      throw new Error(`Supabase query failed: ${dbError.message}`);
    }

    // Fetch any unfinished To-Dos so we can remind the user on their phone
    const { data: pendingTodos } = await supabase
      .from('daily_logs')
      .select('notes')
      .eq('event_type', 'todo_pending')
      .order('created_at', { ascending: true });

    const formattedLogs =
      logs && logs.length > 0
        ? logs
            .map((log) => {
              const timeStr = new Date(log.created_at).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              });
              return `- [${timeStr}] ${log.event_type.toUpperCase()}${
                log.notes ? `: "${log.notes}"` : ''
              }`;
            })
            .join('\n')
        : 'ZERO LOGS RECORDED TODAY (User completely ghosted the habit tracker).';

    const todoReminderText =
      pendingTodos && pendingTodos.length > 0
        ? pendingTodos.map((t, i) => `${i + 1}. ${t.notes}`).join('\n')
        : 'None (all tasks completed)';

    const userPrompt = `Today is ${todayWeekday} (${istDateStr}). Tomorrow is ${tomorrowWeekday}.\n\nToday's Logs:\n${formattedLogs}\n\nUnfinished To-Do Items:\n${todoReminderText}\n\nWrite my 2-sentence midnight review and 1 micro-goal for tomorrow (${tomorrowWeekday}).`;

    const reviewText = await callGeminiWithFallback(DAILY_SYSTEM_INSTRUCTION, userPrompt, 0.5);

    const todoAlertBlock =
      pendingTodos && pendingTodos.length > 0
        ? `\n\n📌 Unfinished To-Do Reminder (${pendingTodos.length}):\n${todoReminderText}`
        : '';

    await sendTelegramMessage(`🌙 Midnight Review (${todayWeekday})\n\n${reviewText}${todoAlertBlock}`);

    return res.status(200).json({
      ok: true,
      date: istDateStr,
      logsCount: logs?.length || 0,
      pendingTodosCount: pendingTodos?.length || 0,
      review: reviewText,
    });
  } catch (err) {
    console.error('Daily Cron Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function callGeminiWithFallback(systemText, userPrompt, temperature = 0.5) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-3.0-flash',
  ];

  try {
    const listRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const discovered = (listData.models || [])
        .filter(
          (m) =>
            m.supportedGenerationMethods?.includes('generateContent') &&
            m.name.includes('flash') &&
            !m.name.includes('tts') &&
            !m.name.includes('image')
        )
        .map((m) => m.name.replace('models/', ''));

      for (const m of discovered) {
        if (!candidateModels.includes(m)) candidateModels.push(m);
      }
    }
  } catch (e) {
    console.error('Model list fetch skipped:', e.message);
  }

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) return text;
    } else {
      console.error(`Cron Gemini (${model}) error:`, await response.text());
    }
  }

  return 'Day complete. Rest up and attack tomorrow’s first scheduled block on time.';
}

async function sendTelegramMessage(text) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!token || !chatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables');
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!res.ok) {
    throw new Error(`Telegram API error (${res.status}): ${await res.text()}`);
  }
}
