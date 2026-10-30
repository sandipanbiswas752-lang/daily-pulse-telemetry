// api/cron.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const SYSTEM_INSTRUCTION = `You are my personal productivity analyst, best-friend strategist, and energy-management coach analyzing my official 7-day habit scoreboard, excuses/reflections, and multi-week trajectory.

### Baseline Weekly Routine & Context
- Commute & College: 3rd-year B.Tech ECE student, commuting 40 mins each way.
- Mondays: Morning tuition batch (7:00 AM - 9:30 AM).
- Tuesdays (Heavy Drain): Morning tuition (7:30 AM - 9:15 AM), college, evening tuition (6:00 PM - 9:30 PM).
- Wednesdays (Focus Window): College ends at 2:00 PM. No evening tuitions. Primary C++ and IoT learning block.
- Thursdays (Heavy Drain): Morning tuition (7:30 AM - 9:30 AM), college, evening tuition (4:00 PM - 9:00 PM).
- Fridays (Focus Window): College ends at 5:00 PM. No evening tuitions. Primary CapCut video editing block.
- Saturdays: Morning tuition (8:00 AM - 10:00 AM), afternoon tuition (4:00 PM - 9:30 PM). Midday is open for hardware projects.
- Sundays: Completely open for recovery and deep work.

### Analysis Rules & Multi-Week Memory Instructions
1. 📈 SCOREBOARD & TRAJECTORY VERDICT: Compare this week's exact Quantitative Scoreboard against the previous weekly summaries provided. State clearly whether my performance is IMPROVING, PLATEAUING, or DEGRADING, citing the exact numbers.
2. 🔍 EXCUSE & BOTTLENECK DIAGNOSIS: Audit my logged 'REFLECTION' entries and late/missed logs. Identify the #1 trigger causing me to lose focus or delay sleep.
3. 🛠️ 3 EVOLVING FIXES (ANTI-REPEAT RULE): Check the fixes suggested in previous weeks. If an old fix failed to solve a recurring problem this week, DO NOT repeat the same generic advice—invent a new, friction-free tactical system (e.g., environment reset before tuition, 5-minute starter trigger, pre-packing meals/notes).
4. STRICT RULE: Fiercely protect Wednesday and Friday evening Focus Windows for C++/IoT and project work. Never schedule heavy cognitive work on Tuesday or Thursday nights.
5. Format cleanly using plain text and simple emojis (no Markdown tables).`;

export default async function handler(req, res) {
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized cron trigger' });
  }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Fetch last 7 days of raw logs
    const { data: logs, error: dbError } = await supabase
      .from('daily_logs')
      .select('created_at, event_type, notes')
      .neq('event_type', 'weekly_summary')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: true });

    if (dbError) {
      throw new Error(`Supabase query failed: ${dbError.message}`);
    }

    // 2. Fetch up to 4 previous Sunday summaries for multi-week memory
    const { data: pastSummaries } = await supabase
      .from('daily_logs')
      .select('created_at, notes')
      .eq('event_type', 'weekly_summary')
      .order('created_at', { ascending: false })
      .limit(4);

    if (!logs || logs.length === 0) {
      const emptyMsg =
        '📊 Weekly Habit Review: No logs recorded in the past 7 days. Log your meals, tuitions, and study blocks this week for next Sunday’s analysis!';
      await sendTelegramReport(emptyMsg);
      return res.status(200).json({ ok: true, message: 'No logs found for the past 7 days' });
    }

    // 3. Build hard quantitative scoreboard so Gemini tracks exact numbers over weeks
    const counts = {
      study: 0,
      tuition: 0,
      college: 0,
      college_study: 0,
      meal: 0,
      wakeup: 0,
      sleep: 0,
      poster: 0,
      exercise: 0,
      reflection: 0,
      todo_done: 0,
      todo_pending: 0,
    };

    logs.forEach((l) => {
      if (counts[l.event_type] !== undefined) counts[l.event_type]++;
    });

    const scoreboardHeader = `[WEEKLY SCOREBOARD | DeepWork(C++/IoT): ${counts.study} | CollegeStudy: ${counts.college_study} | College: ${counts.college} | Tuitions: ${counts.tuition} | Posters: ${counts.poster} | Exercise: ${counts.exercise} | Meals: ${counts.meal} | WakeUps: ${counts.wakeup} | Sleeps: ${counts.sleep} | TodosDone: ${counts.todo_done} | TodosPending: ${counts.todo_pending} | Excuses/Reflections: ${counts.reflection}]`;

    const formattedLogs = logs
      .map((log) => {
        const istTime = new Date(log.created_at).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        return `- [${istTime}] ${log.event_type.toUpperCase()}${
          log.notes ? ` | ${log.notes}` : ''
        }`;
      })
      .join('\n');

    const pastSummaryText =
      pastSummaries && pastSummaries.length > 0
        ? pastSummaries
            .map((s, idx) => {
              const d = new Date(s.created_at).toLocaleDateString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              });
              return `=== PAST SUNDAY AUDIT #${idx + 1} (${d}) ===\n${s.notes}`;
            })
            .join('\n\n')
        : 'No previous weekly summaries stored yet (This is Official Baseline Week 1).';

    const userPrompt = `Here is my multi-week historical memory from previous Sundays:\n${pastSummaryText}\n\nHere is THIS WEEK'S Quantitative Scoreboard:\n${scoreboardHeader}\n\nHere are THIS WEEK'S raw logs (12-hour IST):\n${formattedLogs}\n\nGenerate my Official Sunday Weekly Audit: compare my numbers against past weeks (Improving vs. Degrading), diagnose my reflections/excuses, and give me 3 evolved fixes for the coming week.`;

    const analysisText = await callGeminiWithFallback(SYSTEM_INSTRUCTION, userPrompt, 0.4);
    const fullSavedSummary = `${scoreboardHeader}\n\n${analysisText}`;

    // 4. Save official Sunday summary + scoreboard permanently to Supabase
    await supabase.from('daily_logs').insert([
      {
        event_type: 'weekly_summary',
        notes: fullSavedSummary,
      },
    ]);

    // 5. Send to Telegram
    await sendTelegramReport(`🗓️ Official Sunday Audit & Trend Report\n\n${fullSavedSummary}`);

    // 6. Email to YOUR_EMAIL@gmail.com
    const emailStatus = await sendEmailToGmail(
      `📊 Weekly Habit & ECE Productivity Audit (${new Date().toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
      })})`,
      scoreboardHeader,
      analysisText
    );

    return res.status(200).json({
      ok: true,
      logsAnalyzed: logs.length,
      previousWeeksCompared: pastSummaries?.length || 0,
      emailSent: emailStatus,
      analysis: fullSavedSummary,
    });
  } catch (err) {
    console.error('Weekly Cron Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function sendEmailToGmail(subject, scoreboard, bodyText) {
  const htmlContent = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 620px; margin: 0 auto; background: #090d16; color: #f1f5f9; padding: 24px; border-radius: 16px; border: 1px solid #1e293b;">
      <h2 style="color: #34d399; margin-top: 0;">🗓️ Daily Pulse — Weekly Analyst Report</h2>
      <p style="font-size: 12px; color: #94a3b8;">Prepared for <strong>YOUR_EMAIL@gmail.com</strong></p>
      <div style="background: #0f172a; border: 1px solid #334155; padding: 12px 14px; border-radius: 10px; font-family: monospace; font-size: 12px; color: #38bdf8; margin: 16px 0;">
        ${scoreboard}
      </div>
      <div style="background: #1e293b40; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 8px; font-size: 14px; line-height: 1.6; white-space: pre-line; color: #e2e8f0;">
        ${bodyText}
      </div>
    </div>
  `;

  // Option 1: Free Google Apps Script Webhook
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
      if (res.ok) return 'Sent via GMAIL_WEBHOOK_URL';
    } catch (e) {
      console.error('GMAIL_WEBHOOK_URL error:', e.message);
    }
  }

  // Option 2: Resend Free Tier API
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
      if (res.ok) return 'Sent via RESEND_API_KEY';
    } catch (e) {
      console.error('RESEND_API_KEY error:', e.message);
    }
  }

  return 'Skipped (Add GMAIL_WEBHOOK_URL in Vercel to enable Gmail delivery)';
}

async function callGeminiWithFallback(systemText, userPrompt, temperature = 0.4) {
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

  return 'Weekly review complete. Protect your Wednesday and Friday focus blocks this week.';
}

async function sendTelegramReport(text) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!token || !chatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables');
  }

  const maxLength = 4000;
  for (let i = 0; i < text.length; i += maxLength) {
    const chunk = text.slice(i, i + maxLength);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });

    if (!res.ok) {
      throw new Error(`Telegram API error (${res.status}): ${await res.text()}`);
    }
  }
}
