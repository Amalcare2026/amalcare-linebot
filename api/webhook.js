const line = require('@line/bot-sdk');
const admin = require('firebase-admin');

// Firebase init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").split("\\n").join("\n"),
    }),
  });
}
const db = admin.firestore();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const client = new line.Client(lineConfig);

// User session state
const sessions = {};

async function getVessels() {
  const snap = await db.collection('vessels').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function createOrder(data) {
  const id = 'order_line_' + Date.now();
  const now = new Date();
  const nowStr = now.toLocaleString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  await db.collection('orders').doc(id).set({
    id,
    vesselId: data.vesselId,
    vesselName: data.vesselName,
    title: data.issueType,
    statusText: data.description,
    status: 'preparing',
    progress: 25,
    tech: '',
    due: '',
    createdAt: now.getTime(),
    updatedAtStr: nowStr,
    lineUserId: data.lineUserId,
    source: 'LINE',
  });

  // Send notification to admin
  await db.collection('notifications').doc('notif_line_' + Date.now()).set({
    id: 'notif_line_' + Date.now(),
    type: 'warn',
    icon: '🚤',
    title: '新工單（LINE 回報）',
    desc: `${data.vesselName} — ${data.issueType}：${data.description}`,
    vessel: data.vesselName,
    vesselId: data.vesselId,
    time: nowStr,
    unread: true,
  });

  return id;
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text?.trim();

  if (!sessions[userId]) sessions[userId] = { step: 'start' };
  const session = sessions[userId];

  const reply = (msg) => client.replyMessage(event.replyToken, { type: 'text', text: msg });

  // Start / reset
  if (text === '報修' || text === '回報問題' || session.step === 'start') {
    const vessels = await getVessels();
    if (!vessels.length) {
      return reply('目前系統尚無登記船隻，請聯絡 AmalCare 服務人員。');
    }
    sessions[userId] = { step: 'select_vessel', vessels };
    const list = vessels.map((v, i) => `${i + 1}. ${v.name}`).join('\n');
    return reply(`歡迎使用 AmalCare 報修服務 🚤\n\n請輸入您的船隻編號：\n${list}\n\n（輸入數字即可）`);
  }

  if (session.step === 'select_vessel') {
    const idx = parseInt(text) - 1;
    if (isNaN(idx) || idx < 0 || idx >= session.vessels.length) {
      return reply(`請輸入 1 到 ${session.vessels.length} 之間的數字。`);
    }
    session.selectedVessel = session.vessels[idx];
    session.step = 'select_issue';
    return reply(`已選擇：${session.selectedVessel.name}\n\n請選擇問題類型：\n1. 引擎問題\n2. 船體損傷\n3. 電氣系統\n4. 導航設備\n5. 其他`);
  }

  if (session.step === 'select_issue') {
    const issues = ['引擎問題', '船體損傷', '電氣系統', '導航設備', '其他'];
    const idx = parseInt(text) - 1;
    if (isNaN(idx) || idx < 0 || idx >= issues.length) {
      return reply('請輸入 1 到 5 之間的數字。');
    }
    session.issueType = issues[idx];
    session.step = 'describe';
    return reply(`問題類型：${session.issueType}\n\n請簡單描述問題狀況（例如：引擎啟動時有異聲）：`);
  }

  if (session.step === 'describe') {
    session.description = text;
    session.step = 'confirm';
    return reply(`請確認以下資訊：\n\n🚤 船隻：${session.selectedVessel.name}\n🔧 問題：${session.issueType}\n📝 描述：${session.description}\n\n輸入「確認」送出，或「重新」重新填寫。`);
  }

  if (session.step === 'confirm') {
    if (text === '確認') {
      await createOrder({
        vesselId: session.selectedVessel.id,
        vesselName: session.selectedVessel.name,
        issueType: session.issueType,
        description: session.description,
        lineUserId: userId,
      });
      sessions[userId] = { step: 'start' };
      return reply(`✅ 報修已成功送出！\n\nAmalCare 技師將盡快與您聯繫。\n\n如需再次報修，請輸入「報修」。`);
    } else if (text === '重新') {
      sessions[userId] = { step: 'start' };
      return reply('已重置，請輸入「報修」重新開始。');
    } else {
      return reply('請輸入「確認」送出，或「重新」重新填寫。');
    }
  }

  // Default
  return reply('您好！輸入「報修」開始回報船隻問題 🚤');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('AmalCare LINE Bot is running.');

  const signature = req.headers['x-line-signature'];
  if (!line.validateSignature(JSON.stringify(req.body), lineConfig.channelSecret, signature)) {
    return res.status(403).send('Invalid signature');
  }

  const events = req.body.events;
  await Promise.all(events.map(event => {
    if (event.type === 'message' && event.message.type === 'text') {
      return handleMessage(event).catch(console.error);
    }
  }));

  res.status(200).send('OK');
};
