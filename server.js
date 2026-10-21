import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 1. Слой детерминированного анализа (Slither) ----------
async function runSlither(contractCode) {
  try {
    // В реальном проекте сохраняем код в temp .sol файл и запускаем slither.
    // Для демо используем заглушку, чтобы не ломать запуск без установленного slither.
    // В продакшене раскомментируйте логику ниже и убедитесь, что slither установлен.
    /*
    const fs = await import('fs/promises');
    const tmpFile = `/tmp/contract_${Date.now()}.sol`;
    await fs.writeFile(tmpFile, contractCode);
    const { stdout } = await execAsync(`slither ${tmpFile} --json -`, { timeout: 30000 });
    return JSON.parse(stdout);
    */
    return { note: "Slither отключен в демо. Установите slither и раскомментируйте код.", findings: [] };
  } catch (e) {
    return { error: e.message, findings: [] };
  }
}

// ---------- 2. Слой ИИ: цепочка бесплатных провайдеров ----------

// Провайдер A: OpenRouter (Free Models Router)
async function auditWithOpenRouter(code, slitherReport) {
  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: { 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Smart Audit' }
  });

  const prompt = buildPrompt(code, slitherReport);
  const res = await client.chat.completions.create({
    model: 'openrouter/free', // Автоматически выбирает доступную бесплатную модель [citation:1]
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  return { provider: 'OpenRouter (free router)', model: res.model, text: res.choices[0].message.content };
}

// Провайдер B: Groq (быстрый Llama)
async function auditWithGroq(code, slitherReport) {
  const client = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY,
  });

  const prompt = buildPrompt(code, slitherReport);
  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile', // Одна из бесплатных моделей Groq [citation:3]
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  return { provider: 'Groq (Llama 3.3 70B)', model: res.model, text: res.choices[0].message.content };
}

// Провайдер C: GitHub Models (если есть токен)
async function auditWithGitHub(code, slitherReport) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN не задан');
  const client = new OpenAI({
    baseURL: 'https://models.github.ai/inference',
    apiKey: process.env.GITHUB_TOKEN,
  });

  const prompt = buildPrompt(code, slitherReport);
  const res = await client.chat.completions.create({
    model: 'openai/gpt-4o', // Доступно в бесплатном тире GitHub Models [citation:5]
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  return { provider: 'GitHub Models (GPT-4o)', model: res.model, text: res.choices[0].message.content };
}

function buildPrompt(code, slitherReport) {
  return `Ты — эксперт по безопасности смарт-контрактов. Проведи аудит следующего Solidity-кода.

Исходный код:
\`\`\`solidity
${code}
\`\`\`

Результаты статического анализатора Slither (если есть):
${JSON.stringify(slitherReport, null, 2)}

Найди уязвимости. Для каждой укажи:
1. Название и критичность (Critical/High/Medium/Low).
2. Строку или функцию.
3. Почему это опасно.
4. Как исправить (с примером кода, если возможно).

Будь краток и конкретен. Не выдумывай уязвимости, которых нет. Если код безопасен, так и скажи.`;
}

// Оркестратор: пробуем всех по очереди, пока не получим ответ
async function multiAiAudit(code, slitherReport) {
  const providers = [
    { name: 'OpenRouter', fn: auditWithOpenRouter },
    { name: 'Groq', fn: auditWithGroq },
    { name: 'GitHub', fn: auditWithGitHub },
  ];

  const errors = [];
  for (const p of providers) {
    try {
      const result = await p.fn(code, slitherReport);
      return { success: true, ...result, errors };
    } catch (e) {
      errors.push({ provider: p.name, error: e.message });
    }
  }
  return { success: false, errors };
}

// ---------- API эндпоинт ----------
app.post('/api/audit', async (req, res) => {
  const { code } = req.body;
  if (!code || code.length < 50) {
    return res.status(400).json({ error: 'Код слишком короткий или отсутствует.' });
  }

  try {
    // 1. Статический анализ
    const slitherReport = await runSlither(code);

    // 2. ИИ-аудит (цепочка провайдеров)
    const aiResult = await multiAiAudit(code, slitherReport);

    res.json({
      slither: slitherReport,
      ai: aiResult,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
