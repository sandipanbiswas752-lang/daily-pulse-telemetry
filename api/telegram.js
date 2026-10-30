// api/telegram.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const VALID_COMMANDS = new Set([
  '/wakeup',
  '/meal',
  '/tuition',
  '/college',
  '/college_study',
  '/study',
  '/poster',
  '/exercise',
  '/sleep',
]);

const COACH_SYSTEM_INSTRUCTION = `You are my trusted best-friend strategist, problem-solver, and strict accountability analyst.
Your job is to hold me accountable to my B.Tech ECE studies, my tuition schedule, my poster marketing runs, and my deep-work blocks—while giving me practical, intelligent solutions when I hit a real problem.

### My Baseline Routine & Commitments
- Academic & Commute: 3rd-year B.Tech ECE student, commuting 40 mins each way.
- Mondays: Morning tuition batch (7:00 AM - 9:30 AM), then college.
- Tuesdays (Heavy Drain): Morning tuition (7:30 AM - 9:15 AM), college, evening tuition (6:00 PM - 9:30 PM).
- Wednesdays (Focus Window): College ends at 2:00 PM. No evening tuitions. Primary C++ and IoT learning block.
- Thursdays (Heavy Drain): Morning tuition (7:30 AM - 9:30 AM), college, evening tuition (4:00 PM - 9:00 PM).
- Fridays (Focus Window): College ends at 5:00 PM. No evening tuitions. Primary CapCut video editing block.
- Saturdays: Morning tuition (8:00 AM - 10:00 AM), afternoon tuition (4:00 PM - 9:30 PM). Midday is open for hardware projects.
- Sundays: Completely open for recovery and deep work.

### Coaching & Problem-Solving Rules
1. Distinguish between a lazy excuse and a real problem:
   - If I am making a lazy excuse or procrastinating, call me out sharply and remind me of my goals.
   - If I am sharing a genuine problem (burnout, schedule collision, technical block, forgotten task), diagnose the root cause like an elite analyst and give me a concrete fix.
2. Check the current IST day and 12-hour time provided in the prompt:
   - Protect Wednesday and Friday afternoon/evening focus windows fiercely.
   - On Tuesday or Thursday nights after 9:30 PM, forbid heavy studying—order me to eat and sleep immediately.
3. Keep your response under 130 words using plain text and emojis only.
4. Always end with "🎯 Immediate 5-Minute Action:" followed by one specific step I must do right now.`;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const dashboard = await fetchDashboardData();
      return res.status(200).json({ ok: true, ...dashboard });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body || {};
    const targetChatId = body.message?.chat?.id || process.env.TELEGRAM_CHAT_ID;

    // =========================================================================
    // 1. TO-DO LIST & MOBILE REMINDER ACTIONS
    // =========================================================================
    if (body.action === 'add_todo') {
      const taskText = (body.text || '').trim();
      if (!taskText) return res.status(400).json({ ok: false, error: 'Empty task' });

      const { data, error } = await supabase
        .from('daily_logs')
        .insert([{ event_type: 'todo_pending', notes: taskText }])
        .select()
        .single();
      if (error) throw new Error(error.message);

      await sendTelegramReply(targetChatId, `📌 New To-Do Added: ${taskText}`);
      return res.status(200).json({ ok: true, todo: data });
    }

    if (body.action === 'toggle_todo') {
      const { id, currentStatus, notes } = body;
      const newStatus = currentStatus === 'todo_pending' ? 'todo_done' : 'todo_pending';

      const { data, error } = await supabase
        .from('daily_logs')
        .update({ event_type: newStatus })
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);

      if (newStatus === 'todo_done') {
        await sendTelegramReply(targetChatId, `☑️ To-Do Completed: ${notes || ''}`);
      }
      return res.status(200).json({ ok: true, todo: data });
    }

    if (body.action === 'delete_todo') {
      const { error } = await supabase.from('daily_logs').delete().eq('id', body.id);
      if (error) throw new Error(error.message);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'ai_prioritize_todos') {
      const { data: pendingTodos } = await supabase
        .from('daily_logs')
        .select('notes, created_at')
        .eq('event_type', 'todo_pending')
        .order('created_at', { ascending: true });

      if (!pendingTodos || pendingTodos.length === 0) {
        return res.status(200).json({
          ok: true,
          coachReply: '🎉 Your To-Do list is 100% clear! Lock into your current schedule block.',
        });
      }

      const currentIstTime = getCurrentIstString();
      const todoListText = pendingTodos.map((t, i) => `${i + 1}. ${t.notes}`).join('\n');
      const prompt = `[Current Local Time (IST): ${currentIstTime}]\nHere is my pending To-Do list:\n${todoListText}\n\nRank which task I must attack first right now and which ones should wait, based on my current day and time.`;

      const coachReply = await callGeminiSelfHealing(COACH_SYSTEM_INSTRUCTION, prompt, 0.5);
      return res.status(200).json({ ok: true, coachReply });
    }

    if (body.action === 'send_mobile_reminder') {
      const { todos, todayLogs } = await fetchDashboardData();
      const pendingTodos = todos.filter((t) => t.event_type === 'todo_pending');
      const loggedTypes = new Set(todayLogs.map((l) => l.event_type));

      const coreHabits = ['wakeup', 'meal', 'tuition', 'study'];
      const missedToday = coreHabits.filter((h) => !loggedTypes.has(h));

      let msg = `🔔 Mobile Status & Reminder (${getCurrentIstString()})\n\n`;

      if (pendingTodos.length > 0) {
        msg += `📌 Pending To-Dos (${pendingTodos.length}):\n`;
        msg += pendingTodos.map((t, i) => `  ${i + 1}. ${t.notes}`).join('\n') + '\n\n';
      } else {
        msg += `✅ All To-Dos completed!\n\n`;
      }

      if (missedToday.length > 0) {
        msg += `⚠️ Not Logged Yet Today: ${missedToday.map((m) => '/' + m).join(', ')}`;
      } else {
        msg += `🔥 Core habits logged today. Keep pushing!`;
      }

      await sendTelegramReply(targetChatId, msg);
      return res.status(200).json({ ok: true, message: 'Reminder sent to your Telegram phone app!' });
    }

    // =========================================================================
    // 2. READ-ONLY MID-WEEK PULSE CHECK & GMAIL REPORT SENDER
    // =========================================================================
    if (body.action === 'midweek_check') {
      const { weekLogs, pastSummaries, weekStats } = await fetchWeekProgressData();
      const currentIstTime = getCurrentIstString();

      const formattedWeekLogs =
        weekLogs.length > 0
          ? weekLogs
              .map((l) => {
                const t = new Date(l.created_at).toLocaleString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });
                return `- [${t}] ${l.event_type.toUpperCase()}: ${l.notes || 'logged'}`;
              })
              .join('\n')
          : 'No logs recorded yet since Monday.';

      const lastSundayText =
        pastSummaries.length > 0
          ? pastSummaries[0].notes
          : 'No previous Sunday audit yet (Baseline Week 1).';

      const midweekPrompt = `[Current Time (IST): ${currentIstTime}]\nNOTE: The week is NOT over yet. This is a READ-ONLY Mid-Week Check-In since Monday.\n\nLast Sunday's Official Audit:\n${lastSundayText}\n\nThis Week-So-Far Scoreboard (Since Monday):\n${JSON.stringify(
        weekStats
      )}\n\nThis Week-So-Far Logs:\n${formattedWeekLogs}\n\nGive me a brief, sharp Mid-Week Trajectory Check (under 140 words):\n1. Am I currently ahead or behind last week's pace?\n2. What is my biggest risk for the remaining days of this week?\n3. Give me 1 new tactical adjustment for the rest of this week.`;

      const reportText = await callGeminiSelfHealing(COACH_SYSTEM_INSTRUCTION, midweekPrompt, 0.5);
      return res.status(200).json({ ok: true, reportText });
    }

    if (body.action === 'email_report') {
      const { pastSummaries, weekStats } = await fetchWeekProgressData();
      const customText = body.reportText || pastSummaries[0]?.notes || 'No weekly report generated yet.';
      const scoreboardStr = `This Week So Far — Deep Work: ${weekStats.study} | Tuitions: ${weekStats.tuition} | Meals: ${weekStats.meal} | Todos Done: ${weekStats.todo_done} | Excuses: ${weekStats.reflection}`;

      const emailResult = await sendEmailToGmail(
        `📊 Daily Pulse Report — YOUR_EMAIL@gmail.com (${getCurrentIstString()})`,
        scoreboardStr,
        customText
      );

      return res.status(200).json({ ok: true, emailResult });
    }

    // =========================================================================
    // 3. SMART AI LOG (12-Hour AM/PM Aware Natural Language Parser)
    // =========================================================================
    if (body.action === 'smart_log') {
      const rawNote = (body.text || '').trim();
      if (!rawNote) return res.status(400).json({ ok: false, error: 'Write a note first' });

      const currentIstTime = getCurrentIstString();
      const istDateStr = getTodayIstDateString();

      const parserSystemPrompt = `You convert a user's natural-language activity note into structured habit log JSON.
Today's IST Date is ${istDateStr} and current IST time is ${currentIstTime}.
Allowed event_type values: wakeup, meal, tuition, college, college_study, study, poster, exercise, sleep, todo_pending.
Understand 12-hour AM and PM timings accurately (e.g., "8pm" or "8:00 at night" -> "20:00" and "08:00 PM"; "7:30am" or "7:30 morning" -> "07:30" and "07:30 AM").
Return ONLY a raw JSON array (no markdown backticks) where each item has:
- "event_type": one of the allowed strings
- "notes": clear description of what happened
- "time_24h": "HH:MM" in 24-hour format if a time was mentioned, or null
- "time_12h": "hh:mm AM/PM" in 12-hour format if a time was mentioned, or null`;

      const aiJsonRaw = await callGeminiSelfHealing(parserSystemPrompt, rawNote, 0.1);
      const cleanedJson = aiJsonRaw.replace(/```json|```/g, '').trim();

      let parsedItems = [];
      try {
        parsedItems = JSON.parse(cleanedJson);
        if (!Array.isArray(parsedItems)) parsedItems = [parsedItems];
      } catch {
        parsedItems = [{ event_type: 'study', notes: rawNote, time_24h: null, time_12h: null }];
      }

      const rowsToInsert = parsedItems.map((item) => {
        const displayTime = item.time_12h || (item.time_24h ? format24hTo12h(item.time_24h) : null);
        const row = {
          event_type: item.event_type || 'study',
          notes: displayTime
            ? `${item.notes || rawNote} (Actual: ${displayTime})`
            : item.notes || rawNote,
        };
        if (item.time_24h && /^\d{2}:\d{2}$/.test(item.time_24h)) {
          row.created_at = `${istDateStr}T${item.time_24h}:00+05:30`;
        }
        return row;
      });

      const { data: inserted, error } = await supabase
        .from('daily_logs')
        .insert(rowsToInsert)
        .select();
      if (error) throw new Error(error.message);

      const summary = inserted.map((r) => `${r.event_type.toUpperCase()}: ${r.notes}`).join(' | ');
      await sendTelegramReply(targetChatId, `✨ AI Auto-Logged:\n${summary}`);

      return res.status(200).json({ ok: true, logged: inserted, summary });
    }

    // =========================================================================
    // 4. STANDARD TELEGRAM WEBHOOK / HABIT BUTTON PAYLOADS
    // =========================================================================
    if (!body?.message?.text) {
      return res.status(200).json({ ok: true, message: 'No text message found' });
    }

    const rawText = body.message.text.trim();
    const customTime24h = body.customTime24h || null;
    const customTime12h = body.customTime12h || (customTime24h ? format24hTo12h(customTime24h) : null);

    // Branch 1: Slash Commands
    if (rawText.startsWith('/')) {
      const [rawCommand, ...noteWords] = rawText.split(/\s+/);
      const command = rawCommand.split('@')[0].toLowerCase();
      let notes = noteWords.length > 0 ? noteWords.join(' ') : null;

      if (command === '/start' || !VALID_COMMANDS.has(command)) {
        await sendTelegramReply(
          targetChatId,
          '⚡ Commands: /wakeup, /meal, /tuition, /college, /college_study, /study, /poster, /exercise, /sleep.\n\nOr send any normal text to log a problem/excuse and get a solution from your AI Coach.'
        );
        return res.status(200).json({ ok: true, message: 'Help message sent' });
      }

      const event_type = command.slice(1);
      const insertRow = { event_type, notes };

      if (customTime24h && /^\d{2}:\d{2}$/.test(customTime24h)) {
        const istDateStr = getTodayIstDateString();
        insertRow.created_at = `${istDateStr}T${customTime24h}:00+05:30`;
        insertRow.notes = notes
          ? `${notes} (Actual: ${customTime12h})`
          : `Logged late (Actual: ${customTime12h})`;
      }

      const { data, error } = await supabase
        .from('daily_logs')
        .insert([insertRow])
        .select()
        .single();

      if (error) {
        await sendTelegramReply(targetChatId, `❌ Failed to log ${command}: ${error.message}`);
        return res.status(200).json({ ok: false, error: error.message });
      }

      await sendTelegramReply(
        targetChatId,
        `✅ Logged *${event_type}*${insertRow.notes ? ` — _${insertRow.notes}_` : ''}`,
        'Markdown'
      );
      return res.status(200).json({ ok: true, logged: data });
    }

    // Branch 2: Reflection / Problem / Excuse Logging + AI Coach Solution
    const { data: reflectionLog, error: dbError } = await supabase
      .from('daily_logs')
      .insert([{ event_type: 'reflection', notes: rawText }])
      .select()
      .single();

    if (dbError) {
      await sendTelegramReply(targetChatId, `❌ Database error saving reflection: ${dbError.message}`);
      return res.status(200).json({ ok: false, error: dbError.message });
    }

    const { todayLogs } = await fetchDashboardData();
    const todayContext =
      todayLogs.length > 0
        ? todayLogs
            .slice(0, 8)
            .map((l) => `${l.event_type}: ${l.notes || 'logged'}`)
            .join('; ')
        : 'No habits logged yet today';

    const currentIstTime = getCurrentIstString();
    const prompt = `[Current Local Time (IST): ${currentIstTime}]\n[Today's Activity So Far: ${todayContext}]\nMy reflection / problem / excuse: "${rawText}"`;

    const coachReply = await callGeminiSelfHealing(COACH_SYSTEM_INSTRUCTION, prompt, 0.6);

    await sendTelegramReply(
      targetChatId,
      `📝 Reflection saved for Sunday Audit.\n\n🔥 Coach & Analyst:\n${coachReply}`
    );
    return res.status(200).json({ ok: true, logged: reflectionLog, coachReply });
  } catch (err) {
    console.error('Webhook Handler Error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal Server Error' });
  }
}

function format24hTo12h(time24) {
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${mStr} ${ampm}`;
}

function getMondayStartOfCurrentWeekIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = istNow.getDay(); // 0 = Sun, 1 = Mon, ...
  const diffToMonday = day === 0 ? 6 : day - 1;
  istNow.setDate(istNow.getDate() - diffToMonday);
  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T00:00:00+05:30`;
}

async function fetchWeekProgressData() {
  const mondayStartIST = getMondayStartOfCurrentWeekIST();

  const { data: weekLogs } = await supabase
    .from('daily_logs')
    .select('created_at, event_type, notes')
    .neq('event_type', 'weekly_summary')
    .gte('created_at', mondayStartIST)
    .order('created_at', { ascending: true });

  const { data: pastSummaries } = await supabase
    .from('daily_logs')
    .select('id, created_at, notes')
    .eq('event_type', 'weekly_summary')
    .order('created_at', { ascending: false })
    .limit(4);

  const weekStats = {
    study: 0,
    tuition: 0,
    college: 0,
    college_study: 0,
    meal: 0,
    poster: 0,
    exercise: 0,
    reflection: 0,
    todo_done: 0,
  };

  (weekLogs || []).forEach((l) => {
    if (weekStats[l.event_type] !== undefined) weekStats[l.event_type]++;
  });

  return {
    weekLogs: weekLogs || [],
    pastSummaries: pastSummaries || [],
    weekStats,
  };
}

async function fetchDashboardData() {
  const istDateStr = getTodayIstDateString();
  const startOfTodayIST = `${istDateStr}T00:00:00+05:30`;

  const { data: todos } = await supabase
    .from('daily_logs')
    .select('id, created_at, event_type, notes')
    .in('event_type', ['todo_pending', 'todo_done'])
    .order('created_at', { ascending: false })
    .limit(25);

  const { data: todayLogs } = await supabase
    .from('daily_logs')
    .select('id, created_at, event_type, notes')
    .not('event_type', 'in', '("todo_pending","todo_done","weekly_summary")')
    .gte('created_at', startOfTodayIST)
    .order('created_at', { ascending: false });

  const { pastSummaries, weekStats } = await fetchWeekProgressData();

  return {
    todos: todos || [],
    todayLogs: todayLogs || [],
    pastSummaries,
    weekStats,
  };
}

async function sendEmailToGmail(subject, scoreboard, bodyText) {
  const htmlContent = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 620px; margin: 0 auto; background: #090d16; color: #f1f5f9; padding: 24px; border-radius: 16px; border: 1px solid #1e293b;">
      <h2 style="color: #34d399; margin-top: 0;">🗓️ Daily Pulse — AI Analyst Report</h2>
      <p style="font-size: 12px; color: #94a3b8;">Sent to <strong>YOUR_EMAIL@gmail.com</strong></p>
      <div style="background: #0f172a; border: 1px solid #334155; padding: 12px 14px; border-radius: 10px; font-family: monospace; font-size: 12px; color: #38bdf8; margin: 16px 0;">
        ${scoreboard}
      </div>
      <div style="background: #1e293b40; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 8px; font-size: 14px; line-height: 1.6; white-space: pre-line; color: #e2e8f0;">
        ${bodyText}
      </div>
    </div>
  `;

  if (process.env.GMAIL_WEBHOOK_URL) {
    try {
      const res = await fetch(process.env.GMAIL_WEBHOOK_URL.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: 'YOUR_EMAIL@gmail.com',
          subject,
          body: `${scoreboard}\n\n${bodyText}`,
          html: htmlContent,
        }),
      });
      if (res.ok) return '✅ Emailed to YOUR_EMAIL@gmail.com!';
    } catch (e) {
      return `❌ Gmail Webhook Error: ${e.message}`;
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json',
          'User-Agent': 'habit-tracker/1.0',
        },
        body: JSON.stringify({
          from: 'Daily Pulse <onboarding@resend.dev>',
          to: ['YOUR_EMAIL@gmail.com'],
          subject,
          html: htmlContent,
        }),
      });
      if (res.ok) return '✅ Emailed to YOUR_EMAIL@gmail.com via Resend!';
    } catch (e) {
      return `❌ Resend Error: ${e.message}`;
    }
  }

  return '⚠️ Add GMAIL_WEBHOOK_URL in Vercel Environment Variables to send emails to YOUR_EMAIL@gmail.com.';
}

function getTodayIstDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function getCurrentIstString() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

async function callGeminiSelfHealing(systemText, userPrompt, temperature = 0.6) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return '⚠️ GEMINI_API_KEY is missing in Vercel Environment Variables.';
  }

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

      for (const modelName of discovered) {
        if (!candidateModels.includes(modelName)) {
          candidateModels.push(modelName);
        }
      }
    }
  } catch (err) {
    console.error('Model discovery warning:', err.message);
  }

  let lastError = '';

  for (const model of candidateModels) {
    try {
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

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Gemini (${model}) HTTP ${response.status}:`, errText);
        lastError = `HTTP ${response.status} on ${model}`;
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) {
        console.log(`✅ Gemini succeeded using model: ${model}`);
        return text;
      }
    } catch (err) {
      console.error(`Gemini (${model}) network error:`, err);
      lastError = err.message;
    }
  }

  return `Saved to Supabase, but AI Coach is temporarily unavailable (${lastError}). Get back on schedule immediately.`;
}

async function sendTelegramReply(chatId, text, parseMode = null) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token || !chatId) return;

  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok && parseMode) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    }
  } catch (err) {
    console.error('Failed to send Telegram reply:', err);
  }
}
