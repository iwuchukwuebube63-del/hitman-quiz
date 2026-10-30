const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { User, Quiz, Attempt } = require('./models');
const util = require('./quizUtil');

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = function startBot(app) {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.log('BOT_TOKEN is not set, so the Telegram bot is off.');
    return;
  }

  const SITE = process.env.SITE_NAME || 'HITMAN Quiz';
  const adminIds = (process.env.ADMIN_TG_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!adminIds.length) {
    console.log('ADMIN_TG_IDS is empty. Message the bot once to see your Telegram ID, then add it.');
  }
  const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const useWebhook = Boolean(publicUrl) && process.env.BOT_MODE !== 'polling';

  const bot = new TelegramBot(token, { polling: false });
  const sessions = new Map(); // chatId -> { step, data }

  const send = (chatId, text, opts) => bot.sendMessage(chatId, text, opts);
  const linkFor = (code) => `${publicUrl}/q/${code}`;
  const isAdminId = (id) => adminIds.includes(String(id));
  const cleanName = (s) => String(s || '').replace(/^@/, '').trim();

  // ---------- connection ----------
  if (useWebhook) {
    const hookPath = '/tg/' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 40);
    app.post(hookPath, (req, res) => {
      try {
        bot.processUpdate(req.body);
      } catch (e) {
        console.error('processUpdate error:', e.message);
      }
      res.sendStatus(200);
    });
    bot
      .setWebHook(publicUrl + hookPath)
      .then(() => console.log('Telegram webhook is set'))
      .catch((e) => console.error('Could not set Telegram webhook:', e.message));
  } else {
    bot
      .deleteWebHook()
      .catch(() => {})
      .then(() => bot.startPolling())
      .then(() => console.log('Telegram polling started'))
      .catch((e) => console.error('Could not start Telegram polling:', e.message));
  }
  bot.on('polling_error', (e) => console.error('polling_error:', e.code || e.message));

  // ---------- texts ----------
  const HELP = [
    `${SITE} admin bot`,
    '',
    '/newquiz - create a quiz step by step',
    '/format - get the JSON template for questions',
    '/quizzes - recent quizzes, with delete buttons',
    '/delquiz CODE - delete a quiz',
    '/stats - website stats',
    '/users [name] - list or search users',
    '/ban username - suspend a user',
    '/unban username - restore a user',
    '/admins - list website admins',
    '/addadmin username - make a user a website admin',
    '/removeadmin username - remove admin rights',
    '/cancel - stop what you are doing',
    '',
    'Tip: send me a .json quiz file at any time and I will publish it.',
  ].join('\n');

  const PROMPTS = {
    title: 'Send the quiz title.',
    subtitle: 'Send the subtitle, or - to skip.',
    subject: 'Send the subject, or - to skip.',
    courseCode: 'Send the course code (for example CYB 101), or - to skip.',
    duration: 'How many minutes should the quiz last? Send a number from 1 to 300.',
    questions:
      'Now send the questions as a .json file, or paste the JSON here.\nUse /format to see the layout.',
  };

  // ---------- publishing ----------
  function parseJsonText(text) {
    const t = String(text)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    return JSON.parse(t);
  }

  async function publish(chatId, raw, session) {
    let obj;
    try {
      obj = parseJsonText(raw);
    } catch (e) {
      return send(chatId, `That is not valid JSON (${e.message}). Fix it and send it again.`);
    }
    const input = Array.isArray(obj) ? { questions: obj } : obj;
    const merged = session ? { ...input, ...session.data } : input;
    const parsed = util.parseQuizInput(merged);
    if (parsed.error) {
      return send(
        chatId,
        `Could not publish: ${parsed.error}` + (session ? '\nFix the JSON and send it again, or /cancel.' : '')
      );
    }
    const quiz = await util.createQuiz({
      data: parsed.data,
      owner: null,
      ownerName: 'Admin',
      official: true,
      source: 'bot',
    });
    sessions.delete(chatId);
    return send(
      chatId,
      `Published: ${quiz.title}\n${quiz.questionCount} questions, ${quiz.durationMinutes} min\nCode: ${quiz.code}\nLink: ${linkFor(quiz.code)}`,
      { disable_web_page_preview: true }
    );
  }

  async function handleDocument(msg) {
    const chatId = msg.chat.id;
    const doc = msg.document;
    const name = (doc.file_name || '').toLowerCase();
    if (!name.endsWith('.json') && doc.mime_type !== 'application/json') {
      return send(chatId, 'Please send a .json file.');
    }
    if (doc.file_size && doc.file_size > 1024 * 1024) {
      return send(chatId, 'That file is too big. Keep it under 1 MB.');
    }
    const link = await bot.getFileLink(doc.file_id);
    const resp = await fetch(link);
    if (!resp.ok) return send(chatId, 'Could not download that file. Try sending it again.');
    const raw = await resp.text();
    const s = sessions.get(chatId);
    return publish(chatId, raw, s && s.step === 'questions' ? s : null);
  }

  // ---------- guided /newquiz ----------
  async function handleText(msg, text) {
    const chatId = msg.chat.id;
    const s = sessions.get(chatId);
    if (!s) {
      if (text.startsWith('{') || text.startsWith('[') || text.startsWith('```')) {
        return publish(chatId, text, null);
      }
      return send(chatId, 'Send /help to see what I can do.');
    }
    const skip = text === '-';
    switch (s.step) {
      case 'title':
        if (!text) return send(chatId, PROMPTS.title);
        s.data.title = text;
        s.step = 'subtitle';
        return send(chatId, PROMPTS.subtitle);
      case 'subtitle':
        if (!skip) s.data.subtitle = text;
        s.step = 'subject';
        return send(chatId, PROMPTS.subject);
      case 'subject':
        if (!skip) s.data.subject = text;
        s.step = 'courseCode';
        return send(chatId, PROMPTS.courseCode);
      case 'courseCode':
        if (!skip) s.data.courseCode = text;
        s.step = 'duration';
        return send(chatId, PROMPTS.duration);
      case 'duration': {
        const n = Math.round(Number(text));
        if (!(n >= 1 && n <= 300)) return send(chatId, 'Send a number from 1 to 300.');
        s.data.durationMinutes = n;
        s.step = 'questions';
        return send(chatId, PROMPTS.questions);
      }
      case 'questions':
        return publish(chatId, text, s);
      default:
        sessions.delete(chatId);
        return send(chatId, 'Something got mixed up. Send /newquiz to start again.');
    }
  }

  // ---------- admin actions ----------
  function askDelete(chatId, quiz) {
    return send(chatId, `Delete "${quiz.title}" and all its results? This cannot be undone.`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Yes, delete', callback_data: `yes:${quiz.code}` },
            { text: 'Cancel', callback_data: 'no:x' },
          ],
        ],
      },
    });
  }

  async function setBan(chatId, name, banned) {
    if (!name) return send(chatId, `Usage: /${banned ? 'ban' : 'unban'} username`);
    const u = await User.findOne({ username: name.toLowerCase() });
    if (!u) return send(chatId, `No user named "${name}".`);
    if (u.role === 'admin') return send(chatId, 'That user is an admin. Use /removeadmin first.');
    u.banned = banned;
    await u.save();
    return send(chatId, `${u.displayName} is now ${banned ? 'suspended' : 'restored'}.`);
  }

  async function setRole(chatId, name, role) {
    if (!name) return send(chatId, `Usage: /${role === 'admin' ? 'addadmin' : 'removeadmin'} username`);
    const u = await User.findOne({ username: name.toLowerCase() });
    if (!u) {
      return send(chatId, `No user named "${name}". They need to join the website first.`);
    }
    u.role = role;
    if (role === 'admin') u.banned = false;
    await u.save();
    return send(
      chatId,
      role === 'admin'
        ? `${u.displayName} is now a website admin.`
        : `${u.displayName} is now a regular user.`
    );
  }

  async function handleCommand(msg, text) {
    const chatId = msg.chat.id;
    const parts = text.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/start':
      case '/help':
        return send(chatId, HELP);

      case '/cancel':
        sessions.delete(chatId);
        return send(chatId, 'Cancelled.');

      case '/newquiz':
        sessions.set(chatId, { step: 'title', data: {} });
        return send(chatId, `New quiz. Send /cancel to stop.\n\n${PROMPTS.title}`);

      case '/format': {
        const json = JSON.stringify(util.TEMPLATE, null, 2);
        await send(
          chatId,
          'Each question needs "question", "options" (2 to 6) and "answer" (the letter of the correct option). "explanation" is optional.\n\n<pre>' +
            escHtml(json) +
            '</pre>',
          { parse_mode: 'HTML' }
        );
        return bot.sendDocument(chatId, Buffer.from(json), {}, {
          filename: 'quiz-template.json',
          contentType: 'application/json',
        });
      }

      case '/quizzes': {
        const list = await Quiz.find().select('-questions').sort({ createdAt: -1 }).limit(10);
        if (!list.length) return send(chatId, 'No quizzes yet. Send /newquiz to add one.');
        const lines = list.map(
          (q, i) =>
            `${i + 1}. ${q.title} [${q.courseCode || 'no code'}]\n   ${q.questionCount} questions, ${q.durationMinutes} min, ${q.attempts} attempts, by ${q.ownerName}${q.official ? ' (official)' : ''}\n   ${linkFor(q.code)}`
        );
        return send(chatId, lines.join('\n\n'), {
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: list.map((q, i) => [
              { text: `Delete ${i + 1}. ${q.title.slice(0, 30)}`, callback_data: `del:${q.code}` },
            ]),
          },
        });
      }

      case '/delquiz': {
        const code = (args[0] || '').toLowerCase();
        if (!code) return send(chatId, 'Usage: /delquiz CODE');
        const quiz = await Quiz.findOne({ code }).select('-questions');
        if (!quiz) return send(chatId, `No quiz with code ${code}.`);
        return askDelete(chatId, quiz);
      }

      case '/stats': {
        const s = await util.getStats();
        const lines = [
          `${SITE} stats`,
          '',
          `Users: ${s.users.total}`,
          `  Joined today: ${s.users.today}, this week: ${s.users.week}`,
          `  Active today: ${s.users.activeToday}`,
          `  Admins: ${s.users.admins}, suspended: ${s.users.banned}`,
          '',
          `Quizzes: ${s.quizzes.total}`,
          `  Official: ${s.quizzes.official}, community: ${s.quizzes.community}`,
          `  Added today: ${s.quizzes.today}`,
          '',
          `Attempts: ${s.attempts.total}`,
          `  Today: ${s.attempts.today}, in progress: ${s.attempts.active}`,
          `  Average score: ${s.attempts.avgPercent}%`,
        ];
        if (s.top.length) {
          lines.push('', 'Most played:');
          s.top.forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${t.attempts})`));
        }
        return send(chatId, lines.join('\n'));
      }

      case '/users': {
        const q = args.join(' ').trim().toLowerCase();
        const filter = q ? { username: new RegExp(util.escapeRegex(q)) } : {};
        const [users, total] = await Promise.all([
          User.find(filter).sort({ createdAt: -1 }).limit(20),
          User.countDocuments(filter),
        ]);
        if (!users.length) return send(chatId, 'No users found.');
        const lines = users.map(
          (u) =>
            `${u.displayName} - ${u.role}${u.banned ? ' - suspended' : ''} - joined ${u.createdAt.toISOString().slice(0, 10)}`
        );
        return send(chatId, `Showing ${users.length} of ${total} users\n\n${lines.join('\n')}`);
      }

      case '/ban':
        return setBan(chatId, cleanName(args[0]), true);
      case '/unban':
        return setBan(chatId, cleanName(args[0]), false);
      case '/addadmin':
        return setRole(chatId, cleanName(args[0]), 'admin');
      case '/removeadmin':
        return setRole(chatId, cleanName(args[0]), 'user');

      case '/admins': {
        const admins = await User.find({ role: 'admin' }).sort({ createdAt: 1 });
        if (!admins.length) return send(chatId, 'No website admins yet. Join the site, then use /addadmin yourusername.');
        return send(chatId, 'Website admins:\n' + admins.map((u) => `- ${u.displayName}`).join('\n'));
      }

      default:
        return send(chatId, 'I do not know that command. Send /help to see the list.');
    }
  }

  // ---------- events ----------
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    try {
      if (!msg.from || !isAdminId(msg.from.id)) {
        return await send(
          chatId,
          `This bot is for admins only.\nYour Telegram ID is ${msg.from ? msg.from.id : 'unknown'}. Add it to ADMIN_TG_IDS to get access.`
        );
      }
      if (msg.document) return await handleDocument(msg);
      const text = (msg.text || '').trim();
      if (!text) return;
      if (text.startsWith('/')) return await handleCommand(msg, text);
      return await handleText(msg, text);
    } catch (e) {
      console.error('bot error:', e);
      send(chatId, `Something went wrong: ${e.message}`).catch(() => {});
    }
  });

  bot.on('callback_query', async (q) => {
    try {
      if (!isAdminId(q.from.id)) {
        return await bot.answerCallbackQuery(q.id, { text: 'Admins only.' });
      }
      const chatId = q.message.chat.id;
      const [action, code] = String(q.data || '').split(':');

      if (action === 'del') {
        const quiz = await Quiz.findOne({ code }).select('-questions');
        if (!quiz) return await bot.answerCallbackQuery(q.id, { text: 'Already deleted.' });
        await bot.answerCallbackQuery(q.id);
        return await askDelete(chatId, quiz);
      }
      if (action === 'yes') {
        const quiz = await Quiz.findOne({ code }).select('-questions');
        if (!quiz) return await bot.answerCallbackQuery(q.id, { text: 'Already deleted.' });
        await Attempt.deleteMany({ quiz: quiz._id });
        await Quiz.deleteOne({ _id: quiz._id });
        await bot.answerCallbackQuery(q.id, { text: 'Deleted.' });
        return await send(chatId, `Deleted "${quiz.title}".`);
      }
      if (action === 'no') {
        await bot.answerCallbackQuery(q.id);
        return await send(chatId, 'Cancelled.');
      }
      await bot.answerCallbackQuery(q.id);
    } catch (e) {
      console.error('callback error:', e);
    }
  });
};
