# HITMAN Quiz

Timed quiz website with a web admin panel and a Telegram admin bot. One Render service runs both.

## What you get

- Join with just a username and password
- Admins upload quizzes (website or Telegram bot); every user can also create quizzes and get a share link
- Quiz = title, subtitle, subject, course code, questions, options, time limit
- Timer runs on the server. When time ends the answers auto-submit, even if the person closed the page
- Score flashcard (save as image / share), then review of missed questions with correct answers
- Leaderboard per quiz
- Web admin panel: stats, all quizzes, all users (suspend or restore)
- Telegram bot: create quizzes step by step or by JSON file, delete quizzes, stats, users, ban, add or remove website admins

## 1. Database (MongoDB Atlas, free)

1. Create a free account at mongodb.com/atlas and make a free (M0) cluster.
2. Database Access: add a user with a password.
3. Network Access: add `0.0.0.0/0` (Render's IPs change).
4. Connect > Drivers: copy the connection string. Put your password in it and add `/quiz` before the `?`.
   That string is your `MONGODB_URI`.

## 2. Telegram bot

1. Open @BotFather, send `/newbot`, copy the token. That is `BOT_TOKEN`.
2. Deploy first (step 3), then message your bot. It replies with your Telegram ID.
3. Put that number in `ADMIN_TG_IDS` and redeploy. Several admins: `111,222`.

## 3. Deploy on Render

1. Push this folder to a GitHub repo.
2. Render > New > Web Service > pick the repo.
3. Runtime Node, Build Command `npm install`, Start Command `npm start`, Instance type Free.
4. Environment variables: `MONGODB_URI`, `JWT_SECRET`, `BOT_TOKEN`, `ADMIN_TG_IDS`
   (optional: `SITE_NAME`, `WATERMARK_TEXT`).
5. Deploy. Render sets `RENDER_EXTERNAL_URL` itself, so the bot webhook and quiz links work with no extra setup.

## 4. Make yourself the first website admin

1. Open the site and join with your username.
2. In the Telegram bot send `/addadmin yourusername`.
3. Refresh the site. You now see Admin in the menu.

## 5. Keep it from sleeping

Render's free plan sleeps after about 15 minutes with no visits. Two layers are built in or free:

1. Built in: the server pings its own `/health` page every 4 minutes.
2. Backup (do this too): create a free monitor at uptimerobot.com (or cron-job.org) for
   `https://YOUR-APP.onrender.com/health` every 5 minutes. It also wakes the site if it ever does sleep.

Note: Render gives 750 free hours per month across all your free web services. One always-on service
uses about 744, so this site alone fits. If other free services on the same Render account are also
always on, you will run out before month end.

## Telegram bot commands

| Command | What it does |
| --- | --- |
| `/newquiz` | Asks for title, subtitle, subject, course code, minutes, then the questions JSON |
| `/format` | Sends the JSON template (message and file) |
| (send a .json file) | Publishes the quiz straight away |
| `/quizzes` | Last 10 quizzes with links and delete buttons |
| `/delquiz CODE` | Delete a quiz |
| `/stats` | Full website stats |
| `/users [name]` | List or search users |
| `/ban`, `/unban` | Suspend or restore a user |
| `/admins`, `/addadmin`, `/removeadmin` | Manage website admins |

## Quiz JSON format

```json
{
  "title": "Cyber Security Basics",
  "subtitle": "Week 3 test",
  "subject": "Introduction to Cyber Security",
  "courseCode": "CYB 101",
  "durationMinutes": 10,
  "questions": [
    {
      "question": "What does the CIA triad stand for in security?",
      "options": ["Central Intelligence Agency", "Confidentiality, Integrity, Availability", "Control, Identify, Authorize", "None of the above"],
      "answer": "B",
      "explanation": "Optional text shown in the review."
    }
  ]
}
```

- 2 to 6 options per question; `answer` is the letter of the correct option.
- If you use `/newquiz`, the bot already has the title, subject, code and minutes, so you can send just the `questions` list.

## Run locally

```
npm install
cp .env.example .env   # fill it in
npm start
```
Without a public URL the bot runs in polling mode, so it works locally too.
