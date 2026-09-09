const PRIVATE_SPREADSHEET_ID = '1lLUezGr04gttZmCjozdXOUr60iM6OX1ezrYWKwC1J1g';
const SPREADSHEET_ID = '1Up1DFaOAddIEX_ac-ewJb656P8cWrna8uHk3TuipjVE';
const SHEET_NAME = 'Data';

const DOC_DELIVERY_SPREADSHEET_ID = '16OvxNx6hzoaXR9CiKS0d7XuUgNOXrSX5z6mpAcwfHwI';
const DOC_DELIVERY_SHEET_NAME = '2026';

const INGESTION_LOG_SPREADSHEET_ID = '10Bb29mvsPseVmNySShF93hejqCxpJRon0YC2-NyMBnQ';
const INGESTION_LOG_SHEET_NAME = 'Chat_Ingestion_Logs';

const STAMP_DOC_SPREADSHEET_ID = '1jmiNyx69vxJE4xhJV8t5y2L5jrLwVZhZ2TswDSQX6Wg';

const BUILD_ID = 'otregister-debug-2026-04-20-01';

// Bảng ánh xạ commandId → tên lệnh Slash Command (theo cấu hình Google Chat API)
// /Penalty&Bonus = 1, /OfficeSupply = 2, /Sendmessage = 3,
// /OTRegistration = 4, /DeliverDocument = 5, /StampDocument = 6
const SLASH_COMMAND_MAP = {
  '1': '/Penalty&Bonus',
  '2': '/OfficeSupply',
  '3': '/Sendmessage',
  '4': '/OTRegistration',
  '5': '/DeliverDocument',
  '6': '/StampDocument',
};

function removeAccents(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function safeTrim(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function getIncomingMessageText(event) {
  const rawText = event?.message?.text;
  const messageText = (typeof rawText === 'string' ? rawText.trim() : '');
  if (messageText) return messageText;

  const argumentText = event?.message?.argumentText;
  if (typeof argumentText === 'string' && argumentText.trim()) {
    return argumentText.trim();
  }

  const slashCommandId = event?.message?.slashCommand?.commandId;
  if (slashCommandId != null) {
    const id = String(slashCommandId);
    if (SLASH_COMMAND_MAP[id]) return SLASH_COMMAND_MAP[id];
    // Fallback: commandId chưa được đăng ký trong bảng ánh xạ
    Logger.log('[SlashCommand] Không tìm thấy commandId=' + id + ' trong SLASH_COMMAND_MAP');
    return '';
  }

  return '';
}

// ============================================================================
// 🧠 INGESTION LAYER & MULTI-TURN CONVERSATION MEMORY (Audit Log & Memory)
// Google Sheet ID: 1pGM4vccoMkneZpFrWLesHrZruiZJqsATrnrHzId1ZhM
// ============================================================================

/**
 * Ghi log lưu vết câu hỏi và câu trả lời vào Google Sheet Ingestion Layer.
 * Chạy bất đồng bộ an toàn (Non-blocking): Lỗi ghi log không bao giờ làm ngắt phản hồi cho User.
 */
function logUserIngestionAsync(event, intentType, questionText, responseText, executionTimeMs) {
  try {
    var spaceId = event?.space?.name || "DM";
    var userEmail = event?.user?.email || "N/A";
    var displayName = event?.user?.displayName || "N/A";
    var nowStr = Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "dd/MM/yyyy HH:mm:ss");

    var qClean = (questionText || "").trim();
    var rClean = "";
    if (typeof responseText === "string") {
      rClean = responseText.trim();
    } else if (responseText && responseText.text) {
      rClean = responseText.text.trim();
    } else if (responseText && responseText.cardsV2) {
      // Trích xuất text thực từ các widgets trong Card V2 thay vì log "[Card V2 Response]"
      try {
        var textParts = [];
        var cards = responseText.cardsV2;
        for (var ci = 0; ci < cards.length; ci++) {
          var card = cards[ci].card;
          if (!card) continue;
          // Thêm tiêu đề header
          if (card.header && card.header.title) textParts.push("[" + card.header.title + "]");
          var sections = card.sections || [];
          for (var si = 0; si < sections.length; si++) {
            var widgets = sections[si].widgets || [];
            for (var wi = 0; wi < widgets.length; wi++) {
              var w = widgets[wi];
              if (w.textParagraph && w.textParagraph.text) {
                // Bỏ thẻ HTML để lấy text thuần
                var plain = w.textParagraph.text.replace(/<[^>]+>/g, "").trim();
                if (plain) textParts.push(plain);
              }
              if (w.buttonList && w.buttonList.buttons) {
                for (var bi = 0; bi < w.buttonList.buttons.length; bi++) {
                  if (w.buttonList.buttons[bi].text) {
                    textParts.push("[Nút: " + w.buttonList.buttons[bi].text + "]");
                  }
                }
              }
            }
          }
        }
        rClean = textParts.join(" | ");
        if (!rClean) rClean = "[Card V2 Response]";
      } catch (eParse) {
        rClean = "[Card V2 Response]";
      }
    } else {
      rClean = JSON.stringify(responseText) || "";
    }
    if (rClean.length > 2000) rClean = rClean.substring(0, 2000) + "... [Truncated]";

    // Cache lại lượt chat mới nhất vào CacheService (cho Multi-turn Memory)
    var cacheKey = "CHAT_MEM_" + removeAccents(spaceId + "_" + userEmail).replace(/[^a-z0-9]/g, "_");
    try {
      var cachedMemory = CacheService.getScriptCache().get(cacheKey);
      var memList = cachedMemory ? JSON.parse(cachedMemory) : [];
      memList.push({ time: nowStr, user: qClean, bot: rClean.substring(0, 300) });
      if (memList.length > 5) memList = memList.slice(-5); // Giữ 5 lượt gần nhất
      CacheService.getScriptCache().put(cacheKey, JSON.stringify(memList), 900); // Cache 15 phút
    } catch (eMem) { }

    // Ghi vào Google Sheet Ingestion Layer
    var ss = SpreadsheetApp.openById(INGESTION_LOG_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(INGESTION_LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(INGESTION_LOG_SHEET_NAME);
      sheet.appendRow([
        "Timestamp",
        "Space_ID",
        "User_Email",
        "Display_Name",
        "Intent_Type",
        "User_Question",
        "Bot_Response",
        "Execution_Time_ms"
      ]);
      sheet.getRange("1:1").setFontWeight("bold").setBackground("#e8f0fe");
    }

    sheet.appendRow([
      nowStr,
      spaceId,
      userEmail,
      displayName,
      intentType || "GENERAL_QA",
      qClean,
      rClean,
      executionTimeMs || 0
    ]);
  } catch (e) {
    Logger.log("logUserIngestionAsync error: " + e.message);
  }
}

/**
 * Lấy lịch sử hội thoại gần đây (Multi-turn Conversation Memory) từ CacheService / Google Sheet
 * Trả về chuỗi định dạng đưa vào Gemini System Prompt.
 */
function getRecentConversationHistory(spaceId, userEmail, limitTurns) {
  limitTurns = limitTurns || 3;
  if (!spaceId && !userEmail) return "";

  var spaceKey = spaceId || "DM";
  var emailKey = userEmail || "N/A";
  var cacheKey = "CHAT_MEM_" + removeAccents(spaceKey + "_" + emailKey).replace(/[^a-z0-9]/g, "_");

  // 1. Lấy từ CacheService (Tốc độ < 5ms)
  try {
    var cachedMemory = CacheService.getScriptCache().get(cacheKey);
    if (cachedMemory) {
      var memList = JSON.parse(cachedMemory);
      if (memList && memList.length > 0) {
        var recent = memList.slice(-limitTurns);
        return recent.map(function (m) {
          return "• Người dùng: \"" + m.user + "\"\n  ➔ Bot trả lời: \"" + m.bot + "\"";
        }).join("\n");
      }
    }
  } catch (eCache) { }

  // 2. Nếu Cache hết hạn, đọc 30 dòng gần nhất từ Google Sheet Ingestion Layer
  try {
    var ss = SpreadsheetApp.openById(INGESTION_LOG_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(INGESTION_LOG_SHEET_NAME);
    if (!sheet) return "";

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return "";

    var startRow = Math.max(2, lastRow - 30);
    var numRows = lastRow - startRow + 1;
    var data = sheet.getRange(startRow, 1, numRows, 7).getDisplayValues();

    var history = [];
    var targetUser = (userEmail || "").toLowerCase().trim();

    for (var r = data.length - 1; r >= 0; r--) {
      var rowSpace = String(data[r][1] || "").trim();
      var rowEmail = String(data[r][2] || "").toLowerCase().trim();
      var rowQ = String(data[r][5] || "").trim();
      var rowR = String(data[r][6] || "").trim();

      if ((targetUser && rowEmail === targetUser) || (spaceId && rowSpace === spaceId)) {
        if (rowQ) {
          history.unshift({ user: rowQ, bot: rowR.substring(0, 300) });
          if (history.length >= limitTurns) break;
        }
      }
    }

    if (history.length > 0) {
      return history.map(function (h) {
        return "• Người dùng: \"" + h.user + "\"\n  ➔ Bot trả lời: \"" + h.bot + "\"";
      }).join("\n");
    }
  } catch (eSheet) {
    Logger.log("getRecentConversationHistory error: " + eSheet.message);
  }

  return "";
}

function onMessage(event) {
  const startTime = new Date().getTime();
  try {
    const userEmail = event.user?.email || "";
    const BOSS_EMAILS = ["boss@add-group.net", "800@add-group.net", "ntttrang@planadd.com", "tmtam@add-group.net", "tvluat@add-group.net"];
    const isBoss = BOSS_EMAILS.includes(userEmail);

    const rawText = event?.message?.text;
    const incomingText = getIncomingMessageText(event);
    var message = incomingText || 'Không có nội dung tin nhắn';

    const isPenaltyBonus = message === '/Penalty&Bonus' || message.startsWith('/Penalty&Bonus ');

    // 🔓 Bỏ lớp chặn OAuth2 bắt buộc cho nhân viên (Phương án A):
    // Google Chat đã tự động xác thực email người dùng. Tất cả nhân viên đều có quyền sử dụng Form & Hỏi đáp.
    /*
    const service = getOAuthService();
    if (!isBoss && !service.hasAccess() && !isPenaltyBonus) {
      const authorizationUrl = service.getAuthorizationUrl();
      return {
        text: `You are not authenticated. Please visit <${authorizationUrl}|this link to authenticate>`
      };
    }
    */

    const displayName = event.user?.displayName || 'Anh/Chị';

    const WELCOME_MESSAGE = `😊 Xin chào *${displayName}*! Tôi là *200 AI* - trợ lý thông minh của Phòng 200.
Tôi có thể hỗ trợ bạn với các chức năng sau:

📌 *Hỏi đáp thông minh* (chỉ cần nhắn tin bình thường)
  • Tra cứu nội quy, quy định nhân sự của công ty
  • Xem dữ liệu chấm công tháng gần nhất (muộn, quên, tổng công...)
  • Tra cứu điểm Penalty & Bonus cá nhân
  • Tra cứu lịch bay & vé máy bay của Sếp (291)
  • Tìm link form mẫu tài liệu của ADD Group

⚙️ *Lệnh nhanh* (gõ chính xác để mở form)
  • */Penalty&Bonus* — Chấm điểm cho nhân viên
  • */OfficeSupply* — Đặt văn phòng phẩm
  • */OTRegistration* — Đăng ký làm thêm giờ
  • */DeliverDocument* — Đăng ký chuyển phát hồ sơ
  • */StampDocument* — Đăng ký sử dụng con dấu

💡 *Ví dụ câu hỏi:*
  _"Tháng này tôi đi muộn mấy lần?"_
  _"Tháng này Sếp có lịch bay nào về Việt Nam không?"_
  _"Điểm Bonus của tôi hiện tại là bao nhiêu?"_
  _"Đơn xin nghỉ phép ở đâu?"_

Bạn cần tôi hỗ trợ gì hôm nay? 🙋`;

    // Hàm phát hiện lời chào hoặc tin nhắn không liên quan đến nghiệp vụ
    function isGreetingOrUnrelated(msg) {
      var cleaned = msg.trim().toLowerCase();
      // Loại bỏ @ mention ở đầu hoặc cuối (ví dụ "@200 AI hi" hoặc "hướng dẫn tôi đăng ký tăng ca @200 AI")
      cleaned = cleaned.replace(/<users\/[^>]+>/gi, '').replace(/@200 AI/gi, '').replace(/^@[^\s]+\s*/g, '').trim();

      // Lệnh hợp lệ (bắt đầu bằng /) → không chặn
      if (cleaned.startsWith('/')) return false;

      // Rỗng sau khi làm sạch
      if (!cleaned) return true;

      // Nếu chứa các từ khóa chủ đề nghiệp vụ cụ thể → CHẮC CHẮN LÀ CÂU HỎI THẬT, KO PHẢI GREETING!
      // (Bao gồm các trường hợp: "hướng dẫn tôi đăng ký tăng ca", "hướng dẫn tôi đặt văn phòng phẩm", "tôi muốn nghỉ việc"...)
      var hasSpecificTopic = /tăng ca|overtime|\bot\b|văn phòng phẩm|vpp|penalty|bonus|nghỉ việc|nghỉ phép|muộn|trễ|quên|chấm công|lương|hợp đồng|đơn|biên bản|tài liệu|dự án|con dấu|đóng dấu|dùng dấu|mượn dấu|form dấu|đăng k[ií] dấu|stamp|phạt|thưởng|tim|bom|chuyển phát|gửi hồ sơ|gửi tài liệu|gửi vật phẩm|vé máy bay|lịch bay|chuyến bay|ngày bay|bay từ|bay đến|bay về|vé bay|vé sếp|lịch sếp|sếp bay|madam|vợ sếp|flight|hạ cánh|291|có lịch bay|có vé bay|có chuyến bay|ngày phép|phép còn|số phép|còn phép|phép năm|vacation|leave/.test(cleaned);
      if (hasSpecificTopic) return false;

      // ① Tin nhắn quá ngắn (1-4 ký tự): j, E, o, ok, hi, !, ...
      if (cleaned.length <= 4) return true;

      // ② Không có chữ cái nào (chỉ số, dấu câu, emoji, ký tự đặc biệt)
      if (!/[a-zA-ZÀ-ỹ\u00C0-\u024F\u1EA0-\u1EF9]/.test(cleaned)) return true;

      // ③ Chỉ 1 loại ký tự lặp đi lặp lại: "aaaaaaa", "......", "hhhhhh"
      if (/^(.)\1+$/.test(cleaned)) return true;

      // ④ Tin nhắn KHÔNG CÓ KHOẢNG TRẮNG (1 từ dính liền dài > 4 ký tự không phải URL/Email)
      if (!/\s/.test(cleaned)) {
        var isUrlOrEmail = cleaned.includes('http://') || cleaned.includes('https://') || cleaned.includes('@') || cleaned.includes('www.');
        if (!isUrlOrEmail) return true;
      }

      // ⑤ Chứa dấu chấm phẩy (;) dính giữa các chữ cái
      if (/[a-zA-ZÀ-ỹ];[a-zA-ZÀ-ỹ]/.test(cleaned)) return true;

      // ⑥ Không có nguyên âm nào → spam
      var vietnameseVowels = /[aeiouyàáảãạăắặẳẵằâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/;
      if (!vietnameseVowels.test(cleaned)) return true;

      // ⑦ Danh sách từ khóa lời chào thuần túy / câu hỏi chung chung không kèm topic
      var greetingKeywords = [
        'hi', 'hello', 'hey', 'helo', 'hê lô', 'helu',
        'xin chào', 'chào', 'chào buổi sáng', 'chào buổi chiều', 'chào buổi tối',
        'good morning', 'good afternoon', 'good evening', 'good night',
        'hướng dẫn', 'help', 'trợ giúp', 'giúp tôi', 'giúp mình',
        'bạn làm được gì', 'bot làm gì', 'ai làm được gì', '200 ai',
        'chức năng', 'tính năng', 'sử dụng như thế nào', 'dùng như thế nào',
        'okay', 'yes', 'no', 'có', 'không', 'test', 'thử',
        '👋', '😊', '🙂', '😀', '😃'
      ];

      for (var ki = 0; ki < greetingKeywords.length; ki++) {
        if (cleaned === greetingKeywords[ki] ||
          cleaned.startsWith(greetingKeywords[ki] + ' ') ||
          cleaned.startsWith(greetingKeywords[ki] + ',')) {
          return true;
        }
      }
      return false;
    }

    // Lấy phần message sạch (bỏ @200 AI và các user mention dạng <users/...> nếu có)
    var cleanedMessage = message
      .replace(/<users\/[^>]+>/gi, '')
      .replace(/@200 AI/gi, '')
      .replace(/^@[^\s]+\s*/g, '')
      .trim();

    if (isGreetingOrUnrelated(cleanedMessage) || message === "@200 AI") {
      return { text: WELCOME_MESSAGE };
    }

    // 🚫 Kiểm tra ngôn ngữ xúc phạm / chửi bới chatbot
    var lowerForAbuse = cleanedMessage.toLowerCase();
    var abusePatterns = [
      // 🇻🇳 Tiếng Việt — Chửi thề / xúc phạm
      /\bngu\b/, /\bngốc\b/, /\bnghếch\b/, /\bđần\b/, /\bkhùng\b/, /\bđiên\b/, /\bhâm\b/,
      /\bbị ngu/, /\bngu\s*(vãi|vcl|vkl|vl|quá|thế|thật|thực|lắm|lol|lun|luôn|ghê|kinh|bỏ\s*mẹ)/,
      /\bđồ\s*(ngu|ngốc|khùng|điên|rác|bỏ\s*đi|vô\s*dụng|dở\s*hơi|hâm)/,
      /\bvô\s*dụng\b/, /\bdở\s*hơi\b/, /\bchán\s*bot\b/,
      /\bcút\b/, /\btắt\s*(đi|mẹ|cmm)/, /\bbiến\s*đi\b/,
      /\bbot\s*(ngu|ngốc|dở|rác|vô\s*dụng|bị\s*ngu|hâm|điên|khùng|đần)/,
      /\b(địt|đm|đcm|đkm|vcl|vkl|dcm|đéo|clm)\b/,

      // 🇻🇳 Tiếng Việt — Biến thể "mẹ mày" (mọe, mạ, má, me, mịe...)
      /(mẹ|mọe|mạ|má|mịe|mịa|mje|me)\s*(mày|m)\b/i,

      // 🇻🇳 Tiếng Việt — Dùng "mày/tao" xưng hô (nhục mạ chatbot)
      /\bmày\b/, /\btao\b/,

      // 🇻🇳 Tiếng Việt — Tục tĩu bộ phận cơ thể
      /\b(lồn|buồi|cặc|cc|đĩ|cave|cav)\b/,

      // 🇺🇸 Tiếng Anh
      /\b(fuck|fucking|fucked|stfu|fk|fck|fu)\b/i,
      /\b(shit|shitty|bullshit|bs)\b/i,
      /\b(damn|dammit|goddamn)\b/i,
      /\b(stupid|dumb|idiot|moron|retard|retarded)\b/i,
      /\b(trash|garbage|useless|worthless|pathetic|lame)\b/i,
      /\b(asshole|ass|bitch|bastard|dick|prick|crap)\b/i,
      /\b(wtf|stfu|gtfo|kys|sob)\b/i,
      /\b(shut\s*up|piss\s*off|go\s*to\s*hell|screw\s*you|suck)\b/i,
      /\b(crazy|insane|lunatic|psycho|freak)\b/i,

      // 🇰🇷 Tiếng Hàn — Chửi thề
      /씨발/, /시발/, /씹/, /ㅅㅂ/, /ㅆㅂ/,
      /개새끼/, /개새/, /개놈/, /개년/,
      /병신/, /ㅂㅅ/, /빙신/,
      /지랄/, /ㅈㄹ/, /존나/, /ㅈㄴ/,
      /새끼/, /ㅅㄲ/,
      /쓰레기/, /똥/, /엿/,

      // 🇰🇷 Tiếng Hàn — Nhục mạ (bao gồm dạng chia động từ)
      /미친/, /미쳤/, /ㅁㅊ/,        // 미친 (adj) + 미쳤 (past tense: bị điên)
      /미친놈/, /미친년/,
      /멍청/, /바보/, /한심/, /찐따/,
      /꺼져/, /꺼지/, /ㄲㅈ/,        // 꺼져/꺼지 (cút đi)
      /닥쳐/, /닥치/, /ㄷㅊ/,        // 닥쳐/닥치 (câm miệng)
      /죽어/, /죽을/, /뒤져/, /뒤질/,  // 죽어/뒤져 (chết đi)
      /나가/, /나가라/, /사라져/       // 나가 (biến đi), 사라져 (biến mất)
    ];

    var isAbusive = false;
    for (var ab = 0; ab < abusePatterns.length; ab++) {
      if (abusePatterns[ab].test(lowerForAbuse)) {
        isAbusive = true;
        break;
      }
    }

    if (isAbusive) {
      // 📧 Gửi email báo cáo vi phạm về Phòng 200
      try {
        var now = new Date();
        var timeStr = Utilities.formatDate(now, "Asia/Ho_Chi_Minh", "dd/MM/yyyy HH:mm:ss");
        MailApp.sendEmail({
          to: "800@add-group.net",
          subject: "🚨 [200 AI] Cảnh báo vi phạm ngôn ngữ — " + displayName,
          htmlBody:
            "<div style='font-family:Arial,sans-serif;max-width:600px;margin:auto;border:1px solid #e74c3c;border-radius:8px;overflow:hidden'>" +
            "<div style='background:#e74c3c;color:#fff;padding:16px 20px'>" +
            "<h2 style='margin:0'>🚨 Cảnh báo vi phạm ngôn ngữ trên 200 AI</h2></div>" +
            "<div style='padding:20px'>" +
            "<table style='width:100%;border-collapse:collapse'>" +
            "<tr><td style='padding:8px 12px;font-weight:bold;color:#555;width:140px'>👤 Người vi phạm:</td>" +
            "<td style='padding:8px 12px;color:#e74c3c;font-weight:bold'>" + displayName + "</td></tr>" +
            "<tr style='background:#f9f9f9'><td style='padding:8px 12px;font-weight:bold;color:#555'>📧 Email:</td>" +
            "<td style='padding:8px 12px'>" + userEmail + "</td></tr>" +
            "<tr><td style='padding:8px 12px;font-weight:bold;color:#555'>🕐 Thời gian:</td>" +
            "<td style='padding:8px 12px'>" + timeStr + "</td></tr>" +
            "<tr style='background:#f9f9f9'><td style='padding:8px 12px;font-weight:bold;color:#555'>💬 Nội dung vi phạm:</td>" +
            "<td style='padding:8px 12px;color:#c0392b;font-style:italic'>\"" + cleanedMessage + "\"</td></tr>" +
            "</table>" +
            "<hr style='border:none;border-top:1px solid #eee;margin:16px 0'>" +
            "<p style='color:#888;font-size:13px;margin:0'>📌 Email này được gửi tự động từ hệ thống 200 AI. Vui lòng xem xét và xử lý theo quy định công ty.</p>" +
            "</div></div>"
        });
        Logger.log("[Abuse] Đã gửi email báo cáo vi phạm của " + displayName + " (" + userEmail + ") đến 800@add-group.net");
      } catch (mailErr) {
        Logger.log("[Abuse] Lỗi gửi email báo cáo: " + mailErr.message);
      }

      return {
        text: "⚠️ *Cảnh báo từ hệ thống 200 AI:*\n\n" +
          "Anh/chị *" + displayName + "*, hệ thống ghi nhận tin nhắn của anh/chị chứa ngôn ngữ không phù hợp.\n\n" +
          "🔹 200 AI là công cụ hỗ trợ công việc chung của toàn công ty. Vui lòng sử dụng ngôn ngữ lịch sự và văn minh khi giao tiếp.\n" +
          "🔹 *Nếu tiếp tục vi phạm, tài khoản của anh/chị có thể bị hạn chế quyền sử dụng chatbot.*\n" +
          "🔹 *Tin nhắn vi phạm đã được tự động gửi về Phòng 200 để đánh giá và xem xét hình phạt.*\n\n" +
          "Nếu anh/chị cần hỗ trợ, hãy mô tả vấn đề cụ thể để 200 AI phục vụ tốt hơn. Xin cảm ơn! 🙏"
      };
    }

    var lowerCleaned = cleanedMessage.toLowerCase();

    // Các intent hướng dẫn CHỈ chạy khi người dùng nhắn tin thường, KHÔNG chạy khi gõ Slash Command (bắt đầu bằng /)
    if (!cleanedMessage.startsWith('/')) {
      // Phát hiện ý định hỏi hướng dẫn Đăng ký OT / Làm thêm giờ
      var isOtGuideIntent = /(?:đăng\s*ký|muốn|hướng\s*dẫn|cách|xin|hỏi|ở\s*đâu).*(?:ot|tăng\s*ca|làm\s*thêm\s*giờ|overtime)|(?:ot|tăng\s*ca|làm\s*thêm\s*giờ|overtime).*(?:đăng\s*ký|hướng\s*dẫn|ở\s*đâu|thế\s*nào|như\s*thế\s*nào|bằng\s*cách\s*nào)/i.test(lowerCleaned);
      if (isOtGuideIntent) {
        return {
          text: `Chào anh/chị *${displayName}*, để đăng ký làm thêm giờ (OT), anh/chị vui lòng gõ: */OTRegistration*`
        };
      }

      // Phát hiện ý định hỏi hướng dẫn Đăng ký / Đặt Văn phòng phẩm
      var isVppGuideIntent = /(?:đăng\s*ký|đặt|muốn|hướng\s*dẫn|cách|mua|xin|hỏi|ở\s*đâu).*(?:văn\s*phòng\s*phẩm|vpp)|(?:văn\s*phòng\s*phẩm|vpp).*(?:đăng\s*ký|đặt|hướng\s*dẫn|ở\s*đâu|thế\s*nào|như\s*thế\s*nào|bằng\s*cách\s*nào)/i.test(lowerCleaned);
      if (isVppGuideIntent) {
        return {
          text: `Chào anh/chị *${displayName}*, để đăng ký văn phòng phẩm, anh/chị vui lòng sử dụng lệnh */OfficeSupply*`
        };
      }

      // Phát hiện ý định hỏi hướng dẫn Chấm điểm nhân viên (Penalty & Bonus)
      var isPenaltyGuideIntent = /(?:hướng\s*dẫn|cách|muốn|đăng\s*ký|chấm).*(?:chấm\s*điểm|penalty|bonus)|(?:penalty|bonus).*(?:hướng\s*dẫn|cách|ở\s*đâu|chấm\s*điểm)/i.test(lowerCleaned);
      if (isPenaltyGuideIntent) {
        return {
          text: `Chào anh/chị *${displayName}*, để chấm điểm cho nhân viên, anh/chị vui lòng sử dụng lệnh */Penalty&Bonus*`
        };
      }

      // Phát hiện ý định hỏi hướng dẫn Đăng ký Chuyển phát vật phẩm / hồ sơ
      var isDocDeliveryGuideIntent = /(?:đăng\s*ký|muốn|hướng\s*dẫn|cách|xin|hỏi|ở\s*đâu).*(?:chuyển\s*phát|gửi\s*hồ\s*sơ|gửi\s*tài\s*liệu|gửi\s*vật\s*phẩm)|(?:chuyển\s*phát|gửi\s*hồ\s*sơ).*(?:đăng\s*ký|hướng\s*dẫn|ở\s*đâu|thế\s*nào|như\s*thế\s*nào|bằng\s*cách\s*nào)/i.test(lowerCleaned);
      if (isDocDeliveryGuideIntent) {
        return {
          text: `Chào anh/chị *${displayName}*, để đăng ký chuyển phát vật phẩm hồ sơ, anh/chị vui lòng gõ: */DeliverDocument*`
        };
      }

      // Phát hiện ý định hỏi hướng dẫn Đăng ký sử dụng con dấu
      // Bắt tất cả câu liên quan đến dấu / con dấu / đăng kí dấu / form dấu / sử dụng dấu
      var isStampGuideIntent = /(?:con\s*d[aấ]u|d[aấ]u|đóng\s*d[aấ]u|mượn\s*d[aấ]u|dùng\s*d[aấ]u|s[uử]\s*d[uụ]ng\s*d[aấ]u|đăng\s*k[ií]\s*d[aấ]u|đăng\s*k[yý]\s*d[aấ]u|form\s*d[aấ]u|ki\s*d[aấ]u|ký\s*d[aấ]u|stamp|stampdocument)/i.test(lowerCleaned);
      if (isStampGuideIntent) {
        return {
          text: `Chào anh/chị *${displayName}*, để đăng ký sử dụng con dấu, anh/chị vui lòng gõ: */StampDocument*`
        };
      }
    }

    // 🌴 Kiểm tra ý định hỏi số ngày phép còn lại (bao gồm cả gõ nhầm "phéo")
    // Bỏ qua nếu đây là câu hỏi về quy định / thử việc / chính sách chung (để AI trả lời theo Nội quy)
    var isPolicyOrRuleQuery = /(?:thử\s*việc|quy\s*định|điều\s*lệ|nội\s*quy|chính\s*sách|thế\s*nào|như\s*thế\s*nào|có\s*được.*không|có.*không)/i.test(lowerCleaned);
    var isVacationQuery = !isPolicyOrRuleQuery && /(?:ngày\s*phép|ngày\s*phéo|phép\s*năm|phép\s*còn|còn\s*phép|số\s*phép|phép\s*lại|nghỉ\s*phép|vacation|leave)/i.test(lowerCleaned) && !/(?:đơn|mẫu|thủ\s*tục|hướng\s*dẫn|cách|ở\s*đâu).*(?:xin|đăng\s*ký).*(?:phép|phéo)/i.test(lowerCleaned);
    if (isVacationQuery) {
      var vacResult = handleVacationQuery(cleanedMessage, displayName, userEmail);
      logUserIngestionAsync(event, "VACATION_QUERY", message, vacResult, new Date().getTime() - startTime);
      return vacResult;
    }

    // 🧹 Kiểm tra ý định hỏi Lịch trực vệ sinh công ty (Phòng 200 - Task 275)
    var isCleaningQuery = /(?:vệ\s*sinh|lịch\s*vệ\s*sinh|trực\s*vệ\s*sinh|ai\s*vệ\s*sinh|ai\s*trực|dọn\s*dẹp|sạch\s*sẽ|clean|office\s*clean)/i.test(lowerCleaned);
    if (isCleaningQuery) {
      var cleanResult = handleCleaningScheduleQuery(displayName);
      logUserIngestionAsync(event, "CLEANING_SCHEDULE", message, cleanResult, new Date().getTime() - startTime);
      return cleanResult;
    }

    // ✈️ Kiểm tra ý định hỏi Vé máy bay / Lịch bay / Ngày bay từ Google Sheet (291. Flight ticket)
    if (isFlightTicketRequest(cleanedMessage)) {
      var flightResult = handleFlightTicketRequest(cleanedMessage, displayName, userEmail);
      logUserIngestionAsync(event, "FLIGHT_SEARCH", message, flightResult, new Date().getTime() - startTime);
      return flightResult;
    }

    // 📋 Kiểm tra ý định hỏi Form / Link mẫu chung (CHƯƠNG 3 – nội quy công ty)
    // Ưu tiên trả link trực tiếp, KHÔNG đẩy vào Drive Search
    if (isFormLinkRequest(cleanedMessage)) {
      var formResult = handleFormLinkRequest(cleanedMessage, displayName);
      if (formResult) {
        logUserIngestionAsync(event, "FORM_LINK", message, formResult, new Date().getTime() - startTime);
        return formResult;
      }
    }

    // 🌟 Kiểm tra ý định tìm kiếm tài liệu / file / folder / điều lệ / sổ đỏ trong Google Drive
    if (isLinkRequest(cleanedMessage)) {
      var linkResult = handleLinkRequest(cleanedMessage, displayName, event);
      logUserIngestionAsync(event, "DRIVE_SEARCH", message, linkResult, new Date().getTime() - startTime);
      return linkResult;
    }

    if (isPenaltyBonus) {
      var user = event.user.displayName || event.user.email || 'Unknown User';
      var checkAuthor = authorizationUser(user, event.user.email);

      if (checkAuthor == -1) {
        if (message === '/Penalty&Bonus') {
          return {
            actionResponse: {
              type: 'DIALOG',
              dialogAction: {
                dialog: {
                  body: {
                    sections: [
                      {
                        widgets: [
                          {
                            decoratedText: {
                              text: '<font size="7">You do not have permission to perform this action⚠️.</font>',
                            }
                          }
                        ]
                      }
                    ]
                  }
                }
              }
            }
          };
        } else {
          return {
            text: `Bạn không có quyền thực hiện hành động này ⚠️. (Người dùng: ${user})`
          };
        }
      }

      const isDirectCommand = message !== '/Penalty&Bonus';

      if (isDirectCommand) {
        // Trích xuất danh sách nhân viên từ danh sách được phân quyền
        const staffList = checkAuthor[0];
        const standnameList = checkAuthor[2];
        const staffInfoMap = loadStaffInfoMap();
        const employeeMap = [];
        for (var i = 0; i < staffList.length; i++) {
          const fullName = String(staffList[i][0] || '');
          const stdName = String(standnameList[i][0] || '');
          if (fullName && stdName) {
            const realFullName = staffInfoMap[stdName.toLowerCase()] || staffInfoMap[fullName.toLowerCase()] || '';
            employeeMap.push({
              fullName: fullName,
              stdName: stdName,
              realFullName: realFullName,
              fullNameLower: fullName.toLowerCase(),
              stdNameLower: stdName.toLowerCase(),
              realFullNameClean: removeAccents(realFullName.toLowerCase())
            });
          }
        }

        // === MULTI-LINE GROUPED MESSAGE SUPPORT ===
        // Phát hiện tin nhắn gộp nhiều dòng và xử lý từng dòng độc lập
        const _mlRawText = rawText || '';
        const _mlRawLines = _mlRawText.split('\n');

        // Build danh sách content lines từ raw text, bỏ prefix /Penalty&Bonus ở dòng đầu
        const _mlLineInfos = [];
        {
          const _mlAnns = event.message?.annotations || [];
          let _mlCharOff = 0;
          for (let _ri = 0; _ri < _mlRawLines.length; _ri++) {
            const _rlStart = _mlCharOff;
            const _rlEnd = _mlCharOff + _mlRawLines[_ri].length;
            _mlCharOff = _rlEnd + 1; // +1 for \n

            let _lineContent = _mlRawLines[_ri];
            if (_ri === 0) _lineContent = _lineContent.replace(/^\/Penalty&Bonus\s*/i, '');
            _lineContent = _lineContent.trim();
            if (!_lineContent) continue;

            // Map annotations vào dòng này dựa trên startIndex
            const _lineAnns = _mlAnns.filter(function (ann) {
              if (ann.type !== 'USER_MENTION') return false;
              if (ann.startIndex != null) {
                return ann.startIndex >= _rlStart && ann.startIndex < _rlEnd;
              }
              return false;
            });

            _mlLineInfos.push({ text: _lineContent, annotations: _lineAnns });
          }

          // Fallback: nếu annotation không có startIndex, thử phân bổ dựa trên text
          var _unmapped = _mlAnns.filter(function (a) {
            return a.type === 'USER_MENTION' && a.startIndex == null && a.userMention && a.userMention.user && a.userMention.user.displayName;
          });
          if (_unmapped.length > 0 && _mlLineInfos.length > 1) {
            _unmapped.forEach(function (ann) {
              var dName = removeAccents(ann.userMention.user.displayName.toLowerCase().trim());
              for (var _ui = 0; _ui < _mlLineInfos.length; _ui++) {
                var _lineClean = removeAccents(_mlLineInfos[_ui].text.toLowerCase());
                // Thử khớp từng nhân viên với dòng
                var _matched = false;
                employeeMap.forEach(function (emp) {
                  if (_matched) return;
                  var empClean = removeAccents(emp.fullNameLower);
                  var stdClean = removeAccents(emp.stdNameLower);
                  var dotP = emp.fullNameLower.split('.');
                  var shortClean = removeAccents(dotP[dotP.length - 1].trim());
                  if ((dName.includes(shortClean) || shortClean.length >= 2 && dName.includes(shortClean)) &&
                    (_lineClean.includes('@' + empClean) || _lineClean.includes('@' + stdClean) || _lineClean.includes('@' + shortClean))) {
                    _matched = true;
                  }
                });
                if (_matched) {
                  _mlLineInfos[_ui].annotations.push(ann);
                  break;
                }
              }
            });
          }
        }

        // === KIỂM TRA XEM CÓ PHẢI MULTI-LINE THẬT SỰ KHÔNG ===
        // Chỉ xử lý multi-line nếu có từ 2 dòng trở lên VÀ mỗi dòng đều có điểm số hợp lệ
        // Nếu chỉ dòng đầu có điểm, gộp dòng sau vào reason (tin nhắn dài, nhiều đoạn)
        var _pointRegex = /((?:[-+\u2212\u2013\u2014]\s*[1-5](?![0-9]))|(?:^|[^\p{L}\d])[1-5](?=$|[^\p{L}\d]))/u;
        var _isRealMultiLine = _mlLineInfos.length > 1 && _mlLineInfos.every(function (li) {
          return _pointRegex.test(li.text);
        });

        // Nếu không phải multi-line thật sự nhưng có nhiều dòng: gộp tất cả dòng thành 1 message
        if (_mlLineInfos.length > 1 && !_isRealMultiLine) {
          // Gộp lại toàn bộ text (bỏ prefix /Penalty&Bonus ở đầu dòng đầu)
          var _mergedText = _mlLineInfos.map(function (li) { return li.text; }).join(' ');
          var _mergedAnns = [];
          _mlLineInfos.forEach(function (li) {
            li.annotations.forEach(function (ann) { _mergedAnns.push(ann); });
          });
          // Thay thế lineInfos bằng 1 dòng gộp duy nhất để rơi xuống xử lý single-line bên dưới
          _mlLineInfos.length = 0;
          _mlLineInfos.push({ text: _mergedText, annotations: _mergedAnns });
        }

        if (_isRealMultiLine) {
          var _allResults = [];
          var _allErrors = [];

          for (var _li = 0; _li < _mlLineInfos.length; _li++) {
            var _lineInfo = _mlLineInfos[_li];
            var _lineText = _lineInfo.text;
            var _lineAnns = _lineInfo.annotations;

            // --- Match employees cho dòng này ---
            var _lineEmps = [];
            var _lineMentionNames = [];

            // Strategy 1: Annotation-based matching
            _lineAnns.forEach(function (ann) {
              if (ann.type === 'USER_MENTION' && ann.userMention && ann.userMention.user && ann.userMention.user.displayName) {
                var mName = ann.userMention.user.displayName;
                _lineMentionNames.push(mName);
                var mNameLower = removeAccents(mName.toLowerCase().trim());

                var found = null;
                var highestPriority = 0;

                employeeMap.forEach(function (emp) {
                  var fullNameClean = removeAccents(emp.fullNameLower);
                  var stdNameClean = removeAccents(emp.stdNameLower);
                  var dotParts = emp.fullNameLower.split('.');
                  var shortNameClean = removeAccents(dotParts[dotParts.length - 1].trim());

                  var realFullNameClean = emp.realFullNameClean || '';
                  var rWords = realFullNameClean ? realFullNameClean.split(/\s+/).filter(Boolean) : [];
                  var mWords = mNameLower.split(/\s+/).filter(Boolean);

                  var priority = 0;
                  // 1. Kiểm tra đối chiếu Họ và tên đầy đủ từ sheet StaffInformation
                  if (realFullNameClean && mNameLower === realFullNameClean) {
                    priority = 6;
                  } else if (rWords.length > 0 && mWords.length >= 2) {
                    var matchCount = 0;
                    mWords.forEach(function (mw) {
                      if (rWords.indexOf(mw) !== -1) matchCount++;
                    });
                    if (matchCount === mWords.length) {
                      priority = 6;
                    }
                  }

                  if (priority < 6) {
                    if (mNameLower === fullNameClean || mNameLower === stdNameClean) {
                      priority = 5;
                    } else {
                      var sWords = shortNameClean.split(/\s+/).filter(Boolean);
                      if (mWords.length > 0 && sWords.length > 0) {
                        var matchIndex = -1;
                        for (var idx = 0; idx <= mWords.length - sWords.length; idx++) {
                          var matches = true;
                          for (var j = 0; j < sWords.length; j++) {
                            if (mWords[idx + j] !== sWords[j]) { matches = false; break; }
                          }
                          if (matches) { matchIndex = idx; break; }
                        }
                        if (matchIndex !== -1) {
                          var FAMILIES = ["nguyen", "tran", "le", "pham", "hoang", "huynh", "phan", "vu", "vo", "dang", "bui", "do", "ho", "ngo", "duong", "ly", "dinh"];
                          var isTraditional = FAMILIES.includes(mWords[0]);
                          var COMPOUND_PREFIXES = ["thuy", "anh", "minh", "quoc", "gia", "hong", "kim", "ngoc", "thanh", "dinh", "duy", "hoang", "khanh", "nhat", "bao", "duc", "tuyet", "phuong", "thu", "xuan", "hai", "huu", "van", "thi"];
                          var isCompound = COMPOUND_PREFIXES.includes(mWords[0]);
                          if (isTraditional && (matchIndex + sWords.length === mWords.length)) priority = 4;
                          else if (!isTraditional && ((isCompound && matchIndex + sWords.length === mWords.length - 1) || (!isCompound && matchIndex === 0) || (mWords.length === 1 && matchIndex === 0))) priority = 4;
                          else if (matchIndex === 0 || (matchIndex + sWords.length === mWords.length)) priority = 3;
                          else priority = 2;
                        } else if (shortNameClean.length >= 2 && mNameLower.includes(shortNameClean)) {
                          priority = 1;
                        }
                      }
                    }
                  }
                  if (priority > highestPriority) {
                    highestPriority = priority;
                    found = emp;
                  }
                });

                if (found && !_lineEmps.some(function (e) { return e.stdName === found.stdName; })) {
                  _lineEmps.push(found);
                }
              }
            });

            // Strategy 2: @text matching trên lineText
            if (_lineEmps.length === 0) {
              employeeMap.forEach(function (emp) {
                var fullNameClean = removeAccents(emp.fullNameLower);
                var stdNameClean = removeAccents(emp.stdNameLower);
                var dotParts = emp.fullNameLower.split('.');
                var shortNameClean = removeAccents(dotParts[dotParts.length - 1].trim());
                var lineClean = removeAccents(_lineText.toLowerCase());

                if (lineClean.includes('@' + fullNameClean) ||
                  lineClean.includes('@' + stdNameClean) ||
                  (shortNameClean.length >= 2 && lineClean.includes('@' + shortNameClean))) {
                  if (!_lineEmps.some(function (e) { return e.stdName === emp.stdName; })) {
                    _lineEmps.push(emp);
                  }
                }
              });
            }

            // Strategy 3: Plain name fallback trên lineText
            if (_lineEmps.length === 0) {
              var _sortedEmps = employeeMap.slice().sort(function (a, b) { return b.fullName.length - a.fullName.length; });
              _sortedEmps.forEach(function (emp) {
                var fullNameClean = removeAccents(emp.fullNameLower);
                var stdNameClean = removeAccents(emp.stdNameLower);
                var dotParts = emp.fullNameLower.split('.');
                var shortNameClean = removeAccents(dotParts[dotParts.length - 1].trim());
                var lineClean = removeAccents(_lineText.toLowerCase());

                if (lineClean.includes(fullNameClean) ||
                  lineClean.includes(stdNameClean) ||
                  (shortNameClean.length >= 3 && lineClean.includes(shortNameClean))) {
                  if (!_lineEmps.some(function (e) { return e.stdName === emp.stdName; })) {
                    _lineEmps.push(emp);
                  }
                }
              });
            }

            // Tìm điểm số trong dòng này
            var _linePoint = '';
            var _linePointMatch = _lineText.match(/((?:[-+\u2212\u2013\u2014]\s*[1-5](?![0-9]))|(?<=^|[^\p{L}\d])[1-5](?=$|[^\p{L}\d]))/u);
            if (_linePointMatch) {
              _linePoint = _linePointMatch[1].replace(/\s+/g, '');
              _linePoint = _linePoint.replace(/[\u2212\u2013\u2014]/g, '-');
              if (_linePoint.charAt(0) !== '+' && _linePoint.charAt(0) !== '-') {
                _linePoint = '+' + _linePoint;
              }
            }

            // Validate dòng này
            if (_lineEmps.length === 0) {
              _allErrors.push('Dòng ' + (_li + 1) + ': Không tìm thấy nhân viên.');
              continue;
            }
            if (!_linePoint) {
              _allErrors.push('Dòng ' + (_li + 1) + ': Không tìm thấy điểm số.');
              continue;
            }

            // Trích xuất lý do cho dòng này
            var _lineReason = _lineText;
            if (_linePointMatch) _lineReason = _lineReason.replace(_linePointMatch[0], ' ');
            _lineReason = _lineReason.replace(/<users\/[^>]+>/g, '');
            _lineMentionNames.forEach(function (name) {
              _lineReason = _lineReason.replace(new RegExp('@?' + escapeRegExp(name), 'gi'), '');
            });
            _lineEmps.forEach(function (emp) {
              _lineReason = _lineReason.replace(new RegExp('@?' + escapeRegExp(emp.fullName), 'gi'), '');
              _lineReason = _lineReason.replace(new RegExp('@?' + escapeRegExp(emp.stdName), 'gi'), '');
              var dotParts = emp.fullName.split('.');
              var shortName = dotParts[dotParts.length - 1].trim();
              if (shortName.length >= 2) {
                _lineReason = _lineReason.replace(new RegExp('@?' + escapeRegExp(shortName), 'gi'), '');
              }
            });
            _lineReason = _lineReason.replace(/@\S*/g, '');
            _lineReason = _lineReason.replace(/[,;]\s*$/g, '').replace(/^\s*[,;]/g, '');
            _lineReason = _lineReason.replace(/\s+/g, ' ').trim();
            if (!_lineReason) _lineReason = ' ';

            _allResults.push({
              employees: _lineEmps,
              point: _linePoint,
              pointValue: parseInt(_linePoint),
              reason: _lineReason,
              mentionDisplayNames: _lineMentionNames
            });
          }

          // Kiểm tra kết quả
          if (_allResults.length === 0) {
            var _errMsg = _allErrors.length > 0
              ? 'Không xử lý được tin nhắn gộp:\n' + _allErrors.join('\n')
              : 'Không tìm thấy nhân viên hoặc điểm số trong tin nhắn gộp.';
            return { text: _errMsg };
          }

          // Ghi tất cả kết quả vào Google Sheet
          var _mlSheet = SpreadsheetApp.openById(PRIVATE_SPREADSHEET_ID).getSheetByName(SHEET_NAME);
          if (!_mlSheet) {
            return { text: 'Lỗi: Không tìm thấy trang tính "' + SHEET_NAME + '".' };
          }
          var _mlTimestamp = new Date();
          var _mlScoreMap = getEmployeeTotalScores(true);
          var _mlLastRow = getLastRowInColumn(_mlSheet, 1) + 1;

          var _messLines = [];

          for (var _ri2 = 0; _ri2 < _allResults.length; _ri2++) {
            var _result = _allResults[_ri2];
            var _selectedEmps = _result.employees.map(function (emp) { return emp.stdName; });

            // Ghi vào Sheet
            for (var _wi = 0; _wi < _selectedEmps.length; _wi++) {
              _mlSheet.insertRowAfter(_mlLastRow - 1);
              _mlSheet.getRange(_mlLastRow, 1, 1, 5).setValues([[user, _mlTimestamp, _selectedEmps[_wi], _result.reason, _result.pointValue]]);
              _mlLastRow++;
            }

            // Tạo dòng thông báo cho kết quả này
            var _ptAbs = Math.abs(_result.pointValue);
            var _ptDisplay = '';
            var _ptSign = ' + ';
            if (_result.pointValue > 0) {
              _ptSign = ' + ';
              _ptDisplay = _ptAbs + ' ❤️';
            } else if (_result.pointValue < 0) {
              _ptSign = ' - ';
              _ptDisplay = _ptAbs + ' 💣';
            }

            var _dReason = '';
            if (_result.reason && _result.reason.trim() !== '') {
              _dReason = '. *Reason:* ' + _result.reason;
            }

            var _totalLine = formatTotalLine(_selectedEmps, _mlScoreMap, _result.pointValue);

            _messLines.push('*' + standForName(_selectedEmps) + '*' + _ptSign + _ptDisplay + _dReason + '.' + _totalLine);

            // Cập nhật scoreMap cho dòng tiếp theo (running total chính xác)
            _selectedEmps.forEach(function (empName) {
              if (!_mlScoreMap[empName]) {
                _mlScoreMap[empName] = { hearts: 0, bombs: 0, total: 0 };
              } else if (typeof _mlScoreMap[empName] === 'number') {
                var _oldVal = _mlScoreMap[empName];
                _mlScoreMap[empName] = {
                  hearts: _oldVal >= 0 ? _oldVal : 0,
                  bombs: _oldVal < 0 ? Math.abs(_oldVal) : 0,
                  total: _oldVal
                };
              }
              if (_result.pointValue > 0) {
                _mlScoreMap[empName].hearts += _result.pointValue;
              } else if (_result.pointValue < 0) {
                _mlScoreMap[empName].bombs += Math.abs(_result.pointValue);
              }
              _mlScoreMap[empName].total += _result.pointValue;
            });
          }

          // Thêm lỗi nếu có dòng nào không xử lý được
          if (_allErrors.length > 0) {
            _messLines.push('⚠️ ' + _allErrors.join('\n⚠️ '));
          }

          var _finalMess = _messLines.join('\n\n');
          var _mlSpace = event.space?.name;
          if (_mlSpace) {
            sendMessageByChatBot({ text: _finalMess }, _mlSpace);
            return { actionResponse: { type: 'NEW_MESSAGE' } };
          }
          return { text: _finalMess };
        }
        // === END MULTI-LINE SUPPORT — Nếu chỉ có 1 dòng, code cũ bên dưới chạy bình thường ===

        const matchedEmployees = [];
        // Lưu tên hiển thị từ Google Chat annotation để xóa khỏi reason sau này
        const mentionDisplayNames = [];

        // 1. Kiểm tra native mentions trong annotations của Google Chat
        const annotations = event.message?.annotations || [];
        annotations.forEach(ann => {
          if (ann.type === 'USER_MENTION' && ann.userMention?.user?.displayName) {
            const mName = ann.userMention.user.displayName;
            mentionDisplayNames.push(mName);
            const mNameLower = removeAccents(mName.toLowerCase().trim());

            let found = null;
            let highestPriority = 0;

            employeeMap.forEach(emp => {
              const fullNameClean = removeAccents(emp.fullNameLower);
              const stdNameClean = removeAccents(emp.stdNameLower);
              const dotParts = emp.fullNameLower.split('.');
              const shortNameClean = removeAccents(dotParts[dotParts.length - 1].trim());

              const realFullNameClean = emp.realFullNameClean || '';
              const rWords = realFullNameClean ? realFullNameClean.split(/\s+/).filter(Boolean) : [];
              const mWords = mNameLower.split(/\s+/).filter(Boolean);

              let priority = 0;
              // 1. Kiểm tra đối chiếu Họ và tên đầy đủ từ sheet StaffInformation
              if (realFullNameClean && mNameLower === realFullNameClean) {
                priority = 6;
              } else if (rWords.length > 0 && mWords.length >= 2) {
                let matchCount = 0;
                mWords.forEach(mw => {
                  if (rWords.includes(mw)) matchCount++;
                });
                if (matchCount === mWords.length) {
                  priority = 6;
                }
              }

              if (priority < 6) {
                if (mNameLower === fullNameClean || mNameLower === stdNameClean) {
                  priority = 5;
                } else {
                  const sWords = shortNameClean.split(/\s+/).filter(Boolean);
                  if (mWords.length > 0 && sWords.length > 0) {
                    let matchIndex = -1;
                    for (let idx = 0; idx <= mWords.length - sWords.length; idx++) {
                      let matches = true;
                      for (let j = 0; j < sWords.length; j++) {
                        if (mWords[idx + j] !== sWords[j]) {
                          matches = false;
                          break;
                        }
                      }
                      if (matches) {
                        matchIndex = idx;
                        break;
                      }
                    }

                    if (matchIndex !== -1) {
                      const FAMILIES = ["nguyen", "tran", "le", "pham", "hoang", "huynh", "phan", "vu", "vo", "dang", "bui", "do", "ho", "ngo", "duong", "ly", "dinh"];
                      const isTraditional = FAMILIES.includes(mWords[0]);
                      const COMPOUND_PREFIXES = ["thuy", "anh", "minh", "quoc", "gia", "hong", "kim", "ngoc", "thanh", "dinh", "duy", "hoang", "khanh", "nhat", "bao", "duc", "tuyet", "phuong", "thu", "xuan", "hai", "huu", "van", "thi"];
                      const isCompound = COMPOUND_PREFIXES.includes(mWords[0]);

                      if (isTraditional && (matchIndex + sWords.length === mWords.length)) {
                        priority = 4; // Khớp tên chính (cuối) trong cấu trúc Họ-Đệm-Tên
                      } else if (!isTraditional && ((isCompound && matchIndex + sWords.length === mWords.length - 1) || (!isCompound && matchIndex === 0) || (mWords.length === 1 && matchIndex === 0))) {
                        priority = 4; // Khớp tên chính trong cấu trúc Tên-Đệm-Họ (tên đơn ở đầu, tên kép ở áp chót)
                      } else if (matchIndex === 0 || (matchIndex + sWords.length === mWords.length)) {
                        priority = 3; // Khớp ở biên
                      } else {
                        priority = 2; // Khớp ở giữa
                      }
                    } else if (shortNameClean.length >= 2 && mNameLower.includes(shortNameClean)) {
                      priority = 1;
                    }
                  }
                }
              }

              if (priority > highestPriority) {
                highestPriority = priority;
                found = emp;
              }
            });

            if (found && !matchedEmployees.some(e => e.stdName === found.stdName)) {
              matchedEmployees.push(found);
            }
          }
        });

        // Hàm helper để escape ký tự đặc biệt trong regex
        function escapeRegExp(string) {
          return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        // 2. Kiểm tra text xem có chứa "@stdName" hoặc "@fullName" hoặc "@shortName" không
        if (matchedEmployees.length === 0) {
          employeeMap.forEach(emp => {
            const fullNameClean = removeAccents(emp.fullNameLower);
            const stdNameClean = removeAccents(emp.stdNameLower);
            const dotParts = emp.fullNameLower.split('.');
            const shortNameClean = removeAccents(dotParts[dotParts.length - 1].trim());

            const messageClean = removeAccents(message.toLowerCase());

            if (
              messageClean.includes('@' + fullNameClean) ||
              messageClean.includes('@' + stdNameClean) ||
              (shortNameClean.length >= 2 && messageClean.includes('@' + shortNameClean))
            ) {
              if (!matchedEmployees.some(e => e.stdName === emp.stdName)) {
                matchedEmployees.push(emp);
              }
            }
          });
        }

        // 3. Fallback: Kiểm tra text xem có nhắc đến tên không cần ký tự @ không
        if (matchedEmployees.length === 0) {
          const sortedEmployees = [...employeeMap].sort((a, b) => b.fullName.length - a.fullName.length);
          sortedEmployees.forEach(emp => {
            const fullNameClean = removeAccents(emp.fullNameLower);
            const stdNameClean = removeAccents(emp.stdNameLower);
            const dotParts = emp.fullNameLower.split('.');
            const shortNameClean = removeAccents(dotParts[dotParts.length - 1].trim());

            const messageClean = removeAccents(message.toLowerCase());

            if (
              messageClean.includes(fullNameClean) ||
              messageClean.includes(stdNameClean) ||
              (shortNameClean.length >= 3 && messageClean.includes(shortNameClean))
            ) {
              if (!matchedEmployees.some(e => e.stdName === emp.stdName)) {
                matchedEmployees.push(emp);
              }
            }
          });
        }

        if (matchedEmployees.length === 0) {
          return {
            text: "Không tìm thấy nhân viên nào được gắn thẻ hoặc nhắc tên trong câu lệnh của bạn. Vui lòng gắn thẻ (tag) hoặc nhập đúng tên nhân viên."
          };
        }

        // Tìm điểm số (VD: +1, -2, hoặc 2, v.v., hỗ trợ viết liền không dấu cách như 패널티.-2 và chuẩn hóa các loại dấu trừ)
        let point = '';
        const pointMatch = message.match(/((?:[-+−–—]\s*[1-5](?![0-9]))|(?<=^|[^\p{L}\d])[1-5](?=$|[^\p{L}\d]))/u);
        if (pointMatch) {
          point = pointMatch[1].replace(/\s+/g, "");
          // Chuẩn hóa mọi loại dấu trừ/gạch ngang Unicode về dạng ASCII '-'
          point = point.replace(/[−–—]/g, "-");
          if (!point.startsWith('+') && !point.startsWith('-')) {
            point = '+' + point;
          }
        }

        if (!point) {
          return {
            text: "Không tìm thấy điểm số. Vui lòng nhập điểm số hợp lệ từ -5 đến 5 (ví dụ: +1 hoặc -2)."
          };
        }

        // Trích xuất lý do chấm: loại bỏ điểm số và câu lệnh khỏi tin nhắn để trích xuất lý do sạch sẽ
        let reason = message;
        if (pointMatch) {
          reason = reason.replace(pointMatch[0], " ");
        }
        reason = reason.replace(/^\/Penalty&Bonus\s*/i, "");

        // Xóa native mentions dạng <users/xxx>
        reason = reason.replace(/<users\/[^>]+>/g, "");

        // Xóa tên hiển thị Google Chat (display name từ annotation, VD: "Thủy Tiên Triệu")
        mentionDisplayNames.forEach(name => {
          reason = reason.replace(new RegExp('@?' + escapeRegExp(name), 'gi'), "");
        });

        // Xóa tên nhân viên đã match từ database (bao gồm cả ký tự @ phía trước)
        matchedEmployees.forEach(emp => {
          reason = reason.replace(new RegExp('@?' + escapeRegExp(emp.fullName), 'gi'), "");
          reason = reason.replace(new RegExp('@?' + escapeRegExp(emp.stdName), 'gi'), "");
          // Xóa cả dạng shortName (phần sau dấu chấm cuối cùng)
          const dotParts = emp.fullName.split('.');
          const shortName = dotParts[dotParts.length - 1].trim();
          if (shortName.length >= 2) {
            reason = reason.replace(new RegExp('@?' + escapeRegExp(shortName), 'gi'), "");
          }
        });

        // Xóa các ký tự @ rời rạc còn sót lại
        reason = reason.replace(/@\S*/g, "");
        reason = reason.replace(/\s+/g, " ").trim();

        if (!reason || reason.trim() === "") {
          reason = " ";
        }

        // Ghi vào Google Sheet
        const sheet = SpreadsheetApp.openById(PRIVATE_SPREADSHEET_ID).getSheetByName(SHEET_NAME);
        if (!sheet) {
          return {
            text: `Lỗi: Không tìm thấy trang tính (Sheet) tên là "${SHEET_NAME}" trong file Google Sheet. Vui lòng kiểm tra lại tên Sheet.`
          };
        }
        // Format timestamp có cả ngày + giờ phút (VD: 15/06/2026 09:34)
        const timestamp = new Date();
        const selectedEmployees = matchedEmployees.map(emp => emp.stdName);
        // Chuyển point thành số nguyên: +1 → 1, -2 → -2 (không có dấu +)
        const pointValue = parseInt(point);

        // Đọc tổng điểm hiện tại TRƯỚC KHI ghi để tính tổng chính xác
        var scoreMap = getEmployeeTotalScores(true);

        var lastRow = getLastRowInColumn(sheet, 1) + 1;

        // Chèn thêm dòng mới trước khi ghi để tránh xung đột ARRAYFORMULA
        for (var i = 0; i < selectedEmployees.length; i++) {
          sheet.insertRowAfter(lastRow - 1);
          sheet.getRange(lastRow, 1, 1, 5).setValues([[user, timestamp, selectedEmployees[i], reason, pointValue]]);
          lastRow++;
        }

        // Chuẩn bị tin nhắn thông báo
        const pointAbs = Math.abs(parseInt(point));
        let pointDisplay = "";
        let sign = " + ";
        if (parseInt(point) > 0) {
          sign = " + ";
          pointDisplay = pointAbs + " ❤️";
        } else if (parseInt(point) < 0) {
          sign = " - ";
          pointDisplay = pointAbs + " 💣";
        }

        let displayReason = "";
        if (reason && reason.trim() !== "") {
          displayReason = ". *Reason:* " + reason;
        }

        // Tính tổng điểm mới = điểm cũ + điểm vừa chấm
        var totalLine = formatTotalLine(selectedEmployees, scoreMap, pointValue);

        const mess = "*" + standForName(selectedEmployees) + "*" + sign + pointDisplay + displayReason + "." + totalLine;
        const space = event.space?.name;
        if (space) {
          sendMessageByChatBot({ text: mess }, space);
          return { actionResponse: { type: 'NEW_MESSAGE' } };
        }
        return { text: mess };
      }

      var list = []

      for (var i = 0; i < checkAuthor[0].length; i++) {
        list.push({
          text: checkAuthor[2][i][0],
          value: checkAuthor[2][i][0],
          "bottomText": checkAuthor[1][i][0],
          selected: false
        })
      }

      // Kiểm tra nếu là Slash Command
      if (message === '/Penalty&Bonus') {
        return {
          actionResponse: {
            type: 'DIALOG',
            dialogAction: {
              dialog: {
                body: {
                  sections: [
                    {
                      header: ' 💣 Penalty & Bonus ❤️ ',
                      widgets: [
                        {
                          textParagraph: {
                            text: 'Detail as follow:'
                          }
                        },
                        {
                          selectionInput: {
                            name: 'employeesInput',
                            label: 'Employees',
                            type: 'MULTI_SELECT',
                            "multiSelectMaxSelectedItems": 30,
                            "multiSelectMinQueryLength": 1,
                            items: [
                              ...list
                            ]
                          }
                        },
                        {
                          selectionInput: {
                            name: 'pointInput',
                            label: '0',
                            type: 'DROPDOWN',
                            items: [
                              { text: '1 ❤️', value: '1', selected: false },
                              { text: '2 ❤️', value: '2', selected: false },
                              { text: '3 ❤️', value: '3', selected: false },
                              { text: '4 ❤️', value: '4', selected: false },
                              { text: '5 ❤️', value: '5', selected: false },
                              { text: '1 💣', value: '-1', selected: false },
                              { text: '2 💣', value: '-2', selected: false },
                              { text: '3 💣', value: '-3', selected: false },
                              { text: '4 💣', value: '-4', selected: false },
                              { text: '5 💣', value: '-5', selected: false }
                            ]
                          }
                        },
                        {
                          textInput: {
                            name: 'reasonInput',
                            label: 'Reason',
                            type: 'MULTI_LINE',
                            value: ''
                          }
                        },
                        {
                          buttonList: {
                            buttons: [
                              {
                                text: 'Submit',
                                onClick: {
                                  action: {
                                    functionName: 'submitDialog',
                                    parameters: [
                                      { key: 'action', value: 'submitDialog' }
                                    ]
                                  }
                                }
                              }
                            ]
                          }
                        }
                      ]
                    }
                  ]
                }
              }
            }
          }
        };
      }


      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            dialog: {
              body: {
                sections: [
                  {
                    header: 'Xác thực thành công ✅',
                    widgets: [
                      {
                        textParagraph: {
                          text: WELCOME_MESSAGE
                        }
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      };
    }

    if (message === '/OfficeSupply') {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            dialog: {
              body: {
                sections: [
                  {
                    header: '🧷 <b>Đăng ký văn phòng phẩm</b> 📚 \n Form đăng ký:',
                    widgets: [
                      {
                        textInput: {
                          name: 'vppInput',
                          label: 'Văn phòng phẩm',
                          type: 'MULTI_LINE',
                          value: ''
                        }
                      },
                      {
                        textInput: {
                          name: 'quantityInput',
                          label: 'Số lượng',
                          type: 'MULTI_LINE',
                          value: ''
                        }
                      },
                      // {
                      //   textInput: {
                      //     name: 'unitInput',
                      //     label: 'Đơn vị',
                      //     type: 'MULTI_LINE',
                      //     value: ''
                      //   }
                      // },
                      {
                        textInput: {
                          name: 'linkInput',
                          label: 'Link hình ảnh (nếu có)',
                          type: 'MULTI_LINE',
                          value: ''
                        }
                      },
                      {
                        textParagraph: {
                          text: "<b><i>Note: Sau khi mọi người đăng ký xong, 200 sẽ check số lượng văn phòng phẩm thực tế còn lại tại văn phòng, nếu thiếu sẽ đặt mua thêm!</i></b>"
                        }
                      },
                      {
                        buttonList: {
                          buttons: [
                            {
                              text: 'Submit',
                              onClick: {
                                action: {
                                  functionName: 'submitDialogVPP',
                                  parameters: [
                                    { key: 'action', value: 'submitDialogVPP' }
                                  ]
                                }
                              }
                            }
                          ]
                        }
                      },
                    ]
                  }
                ]
              }
            }
          }
        }
      };
    }

    if (message === '/Sendmessage') {
      var list = getUserForSendmessage()
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            dialog: {
              body: {
                sections: [
                  {
                    header: 'Gửi tin nhắn 💬',
                    widgets: [
                      {
                        selectionInput: {
                          name: 'employeesInput',
                          label: 'Employees',
                          type: 'MULTI_SELECT',
                          "multiSelectMaxSelectedItems": 30,
                          "multiSelectMinQueryLength": 1,
                          items: [
                            ...list
                          ]
                        }
                      },
                      {
                        textInput: {
                          name: 'title',
                          label: 'Tiêu đề',
                          type: 'MULTI_LINE',
                          value: ''
                        }
                      },
                      {
                        textInput: {
                          name: 'message',
                          label: 'Tin nhắn',
                          type: 'MULTI_LINE',
                          value: ''
                        }
                      },
                      {
                        buttonList: {
                          buttons: [
                            {
                              text: 'Submit',
                              onClick: {
                                action: {
                                  functionName: 'submitSendmessage',
                                  parameters: [
                                    { key: 'action', value: 'submitSendmessage' }
                                  ]
                                }
                              }
                            }
                          ]
                        }
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      };
    }

    if (message === '/OTRegistration') {
      var list = getUserForOTRegistration()
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            dialog: {
              body: {
                sections: [
                  {
                    header: 'Đăng ký OverTime 📅',
                    widgets: [
                      {
                        selectionInput: {
                          name: 'staff',
                          label: 'Họ và tên',
                          type: 'MULTI_SELECT',
                          "multiSelectMaxSelectedItems": 1,
                          "multiSelectMinQueryLength": 1,
                          items: [
                            ...list
                          ]
                        }
                      },
                      {
                        textInput: {
                          name: 'project',
                          label: 'Dự án',
                          type: 'SINGLE_LINE',
                          value: ''
                        }
                      },
                      {
                        textInput: {
                          name: 'content',
                          label: 'Nội dung công việc',
                          type: 'SINGLE_LINE',
                          value: ''
                        }
                      },
                      {
                        dateTimePicker: {
                          name: 'startDate',
                          label: 'Ngày bắt đầu',
                          type: 'DATE_TIME', // có thể dùng 'DATE' nếu chỉ cần ngày
                          valueMsEpoch: Date.now() + (7 * 60 * 60 * 1000)
                        }
                      },
                      {
                        dateTimePicker: {
                          name: 'endDate',
                          label: 'Ngày kết thúc',
                          type: 'DATE_TIME',
                          valueMsEpoch: Date.now() + (7 * 60 * 60 * 1000)
                        }
                      },
                      {
                        buttonList: {
                          buttons: [
                            {
                              text: 'Submit',
                              onClick: {
                                action: {
                                  functionName: 'submitOvertime',
                                  parameters: [
                                    { key: 'action', value: 'submitOvertime' },
                                  ],
                                }
                              }
                            }
                          ]
                        }
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      };
    }

    if (message === '/DeliverDocument' || message === '/DocumentsDelivery' || message.toLowerCase() === '/deliverdocument' || message.toLowerCase() === '/documentsdelivery') {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            dialog: buildDocDeliveryDialog('', '', '', '', 'Qua đường bưu điện', '')
          }
        }
      };
    }

    if (message === '/StampDocument' || message.toLowerCase() === '/stampdocument') {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            dialog: buildStampDocumentDialog()
          }
        }
      };
    }

    var response = (typeof rawText === 'string' ? rawText.trim() : ''); // Lấy nội dung câu hỏi của người dùng
    var lowerRes = response.toLowerCase();

    // === TỐI ƯU HÓA NGUỒN DỮ LIỆU ĐỂ AI THÔNG MINH & TRẢ LỜI ĐÚNG TRỌNG TÂM ===
    // 1. Quy định công ty (Nội quy, Điều 2 Xử phạt đi muộn, Link Form Mẫu) LUÔN NẠP (0ms)
    var companyRules = companyRule();

    // 2. Chỉ nạp dữ liệu chấm công khi người dùng THỰC SỰ HỎI VỀ CHẤM CÔNG (muộn, trễ, quên, về sớm, công, ngày công, tổng công, checkin, checkout...)
    var isAttendance = /muộn|trễ|quên|về sớm|chấm công|checkin|checkout|check in|giờ vào|giờ ra|công|ngày công|tổng công|số công|đi làm/.test(lowerRes);

    // 3. Chỉ nạp dữ liệu Penalty & Bonus khi hỏi về tim, bom, điểm đánh giá, penalty, bonus
    var isPenalty = /penalty|bonus|phạt|thưởng|tim|bom|❤️|💣|điểm|đánh giá|điểm phạt|điểm thưởng|số penalty/.test(lowerRes);

    // 4. Chỉ nạp dữ liệu Văn Bản Pháp Lý Thư mục 210 (Documents Management: 211→219) khi hỏi về pháp lý / 211 / văn bản / hợp đồng / điều lệ / ERC / IRC
    var isLegalDoc = /pháp lý|phap ly|211|văn bản|van ban|tài liệu|tai lieu|hợp đồng|hop dong|giấy phép|giay phep|điều lệ|dieu le|erc|irc|đăng ký|giấy chứng nhận|chứng nhận|nhãn hiệu|đấu thầu|bổ nhiệm|sổ đỏ|bất động sản|quyết định|hồ sơ|passport|visa|work permit|công văn|biên bản|bàn giao|năng lực|adc|add|agb|asg|tym|vpa|worksmate/i.test(lowerRes);

    // Nạp dữ liệu Sheet / Drive tương ứng (chỉ nạp khi thực sự cần):
    var bodyData = isAttendance ? getTimeStampData() : '';
    var penaltyData = isPenalty ? getPenaltyData() : '';
    var staffMappingTable = isPenalty ? getStaffInfoMappingPromptTable() : '';
    var legalDocData = isLegalDoc ? getFolder211LegalDocsData() : '';

    // Tra cứu chính xác thông tin nhân viên đang đặt câu hỏi từ Email / DisplayName
    var askingUserDetail = getStaffDetailByEmailOrName(event.user?.email, event.user?.displayName);
    var currentAskingNickName = askingUserDetail ? askingUserDetail.nickName : "";
    var currentAskingFullName = askingUserDetail ? askingUserDetail.fullName : (event.user?.displayName || 'Anh/Chị');

    var conversationHistory = getRecentConversationHistory(event.space?.name, event.user?.email, 3);

    var finalData = '------------------- 1.Quy Định Công Ty (Nội quy, Công thức phạt đi muộn Điều 2, Tất cả Link Form Mẫu) -------------------\n' + companyRules;
    if (staffMappingTable) finalData += '\n' + staffMappingTable;
    if (bodyData) finalData += '\n----------------------- 3.Dữ liệu chấm công --------------\n' + bodyData;
    if (penaltyData) finalData += '\n---------------------- 4.Dữ Liệu Hệ Thống Đánh Giá (Penalty & Bonus) ---------------------\n' + penaltyData;
    if (legalDocData) finalData += '\n---------------------- 5.Dữ Liệu Văn Bản Thư Mục 210 (Documents Management: 211 Company Legal, 212 Reporting, 213 Passport/Visa, 214→219) ---------------------\n' + legalDocData;
    if (conversationHistory) finalData += '\n---------------------- 6.Lịch Sử Hội Thoại Gần Đây (Multi-turn Memory) ---------------------\n' + conversationHistory;

    var promtp1 = "THÔNG TIN NGƯỜI ĐANG ĐẶT CÂU HỎI (ĐỐI TƯỢNG 'TÔI'):\n" +
      "- Họ và tên người dùng: " + currentAskingFullName + "\n" +
      "- Email: " + (event.user?.email || "N/A") + "\n" +
      "- Nick Name chính xác trong bảng điểm Penalty & Bonus: \"" + (currentAskingNickName || currentAskingFullName) + "\"\n\n" +
      "QUY TẮC CỰC KỲ NGHIÊM NGẶT VỀ ĐỐI CHIẾU TÊN VÀ NICK NAME (TUYỆT ĐỐI KHÔNG ĐƯỢC LẦM LẪN):\n" +
      "1. Khi câu hỏi dùng từ 'tôi', 'mình', 'cá nhân tôi', hoặc khi hỏi về đi muộn/chấm công/về sớm/quên chấm công/ngày công bị trừ mà KHÔNG nêu rõ tên nhân viên khác, BẮT BUỘC tra cứu dữ liệu trong mục 'Dữ Liệu Chấm Công' ứng với Tên nhân viên \"" + currentAskingFullName + "\" (hoặc Nick Name \"" + (currentAskingNickName || currentAskingFullName) + "\"). BẮT BUỘC liệt kê đầy đủ: Tổng số lần đi muộn/quên, chi tiết từng ngày đi muộn (ngày, giờ checkin) và lý do/ghi chú. CẤM TUYỆT ĐỐI KHÔNG ĐƯỢC BẢO 'hệ thống chưa tích hợp' HOẶC 'chưa có dữ liệu chấm công cá nhân' KHI ĐÃ CÓ BẢNG CHẤM CÔNG CỦA HỌ TRONG DATA!\n" +
      "2. CẤM TUYỆT ĐỐI KHÔNG ĐƯỢC NHẦM LẪN giữa các nhân viên trùng tên nhưng khác Nick Name! Ví dụ:\n" +
      "   • Nguyễn Quỳnh Trang ➔ Nick Name chính xác là 300.Trang (hoặc TYM.Trang). KHÔNG ĐƯỢC NHẦM SANG VPA.Trang!\n" +
      "   • Nguyễn Thị Thu Trang ➔ Nick Name chính xác là VPA.Trang. KHÔNG ĐƯỢC NHẦM SANG 300.Trang!\n" +
      "   • CẤM TUYỆT ĐỐI không được trả về dữ liệu của VPA.Trang khi người dùng hỏi về Nguyễn Quỳnh Trang / 300.Trang / TYM.Trang!\n" +
      "3. Khi người dùng hỏi tên hoặc Nick Name nào (ví dụ 'Nguyễn Quỳnh Trang', 'TYM.Trang', '300.Trang', 'ASG.Trang'), hãy tra cứu đúng Bảng Ánh Xạ Nhân Viên để lấy Nick Name tương ứng trước khi đối chiếu dữ liệu điểm. Nếu không tìm thấy Nick Name đó trong bảng ánh xạ hoặc bảng điểm thì báo rõ không có dữ liệu cho nhân viên đó, KHÔNG ĐƯỢC tự ý lấy dữ liệu của nhân viên khác (như VPA.Trang hay TYM.Kien) để trả lời thay thế!\n" +
      "4. QUAN TRỌNG VỀ CÂU HỎI AI ĐÃ ĐÁNH PENALTY/BONUS VÀ CHẤM CÔNG:\n" +
      "   - Trong dữ liệu có mục 'Lịch sử chi tiết các lần đánh giá Penalty & Bonus', tên người chấm điểm được ghi rõ ở trường 'Người đánh giá [...]'. Khi người dùng hỏi ai đã đánh penalty/bom hoặc bonus/tim cho tôi/ai đó, BẮT BUỘC trích xuất chính xác Người đánh giá, Ngày giờ, Số tim/bom và Lý do từ Lịch sử chi tiết!\n" +
      "   - Trong data chấm công, trường detail sẽ có thể có dữ liệu là 'Muộn Muộn' thì cái đấy tính muộn 2 lần nhé.\n" +
      "   - Nếu người dùng hỏi muộn hoặc quên hoặc hỏi bị trừ bao nhiêu ngày công: BẮT BUỘC tra cứu trong 'Dữ Liệu Chấm Công' của đúng nhân viên đó và đối chiếu số lần đi muộn/về sớm với quy định tại 'Điều 2 [Xử phạt lỗi đi muộn, về sớm]' trong Quy Định Công Ty để TÍNH TOÁN CHÍNH XÁC số ngày công bị trừ và giải thích từng bước. TUYỆT ĐỐI KHÔNG BẢO NGƯỜI DÙNG LIÊN HỆ PHÒNG NHÂN SỰ VÀ KHÔNG BẢO HỆ THỐNG CHƯA TÍCH HỢP CHẤM CÔNG CÁ NHÂN!";

    const promtp = "BẮT BUỘC TRẢ LỜI BẰNG ĐÚNG NGÔN NGỮ CỦA CÂU HỎI (STRICT LANGUAGE MATCHING RULE):\n" +
      "- NẾU CÂU HỎI BẰNG TIẾNG HÀN (한국어) ➔ BẮT BUỘC TRẢ LỜI 100% BẰNG TIẾNG HÀN (한국어)! CẤM TRẢ LỜI BẰNG TIẾNG VIỆT HOẶC TRỘN TIẾNG VIỆT VÀO CÂU TRẢ LỜI!\n" +
      "- NẾU CÂU HỎI BẰNG TIẾNG VIỆT ➔ TRẢ LỜI BẰNG TIẾNG VIỆT.\n" +
      "- NẾU CÂU HỎI BẰNG TIẾNG ANH ➔ TRẢ LỜI BẰNG TIẾNG ANH.\n\n" +
      "Đây là dữ liệu từ các nguồn của công ty:\n" + finalData + "\n\nVà đây là câu hỏi của anh/chị " + currentAskingFullName + ": " + JSON.stringify(response) + "\n. Nhiệm vụ của bạn là đánh giá câu hỏi sau đó chọn đúng nguồn dữ liệu sau đó trả lại câu trả lời ĐÚNG TRỌNG TÂM, NGẮN GỌN VÀ DÙNG ĐÚNG NGÔN NGỮ CỦA CÂU HỎI. YÊU CẦU QUAN TRỌNG VỀ ĐỊNH DẠNG: BẮT BUỘC dùng định dạng in đậm Markdown **nội dung** cho tất cả các thông tin quan trọng trong câu trả lời. QUY TẮC TRẢ LỜI:\n" +
      "- Nếu hỏi bằng Tiếng Hàn (한국어): Dịch toàn bộ thông tin phản hồi sang Tiếng Hàn lịch sự (존댓말), bao gồm lời chào, nội dung giải đáp và câu chúc.\n" +
      "- Nếu hỏi về văn bản pháp lý, hồ sơ công ty, hợp đồng, điều lệ hoặc tài liệu thuộc Thư mục 211 (ADC, ADD, AGB, ASG, TYM VINA, VPA, Worksmate...): BẮT BUỘC liệt kê danh sách tài liệu tìm thấy, tóm tắt nội dung chính và đính kèm URL đầy đủ dạng '• **Tên tài liệu** — URL_đầy_đủ'. TUYỆT ĐỐI KHÔNG dùng cú pháp '<link|...>' vì Google Chat không hỗ trợ!\n" +
      "- Nếu hỏi về mẫu đơn, biên bản: Trả lời ngay câu chào + URL đầy đủ dạng '• **Tên mẫu đơn** — URL_đầy_đủ'. Google Chat sẽ tự bấm được link. CẤM IN DÒNG THÔNG BÁO CHẤM CÔNG CẬP NHẬT! TUYỆT ĐỐI KHÔNG dùng cú pháp '<link|...>'!\n" +
      "- Khi hỏi 'hướng dẫn đăng ký tăng ca/OT' hoặc 'đăng ký OT': CHỈ TRẢ LỜI 1 DÒNG hướng dẫn dùng lệnh '• */OTRegistration* — Đăng ký làm thêm giờ'. TUYỆT ĐỐI KHÔNG IN LINK FORM HOẶC SHEET, KHÔNG IN LẠI WELCOME MESSAGE VÀ CẤM IN DÒNG THÔNG BÁO CHẤM CÔNG!\n" +
      "- Khi hỏi 'hướng dẫn đặt văn phòng phẩm' hoặc 'đăng ký văn phòng phẩm': CHỈ TRẢ LỜI 1 DÒNG hướng dẫn dùng lệnh '• */OfficeSupply* — Đặt văn phòng phẩm'. TUYỆT ĐỐI KHÔNG IN LINK FORM HOẶC SHEET, KHÔNG IN LẠI WELCOME MESSAGE VÀ CẤM IN DÒNG THÔNG BÁO CHẤM CÔNG!\n" +
      "- Khi hỏi 'hướng dẫn đăng ký chuyển phát hồ sơ' hoặc 'chuyển phát hồ sơ/vật phẩm': CHỈ TRẢ LỜI 1 DÒNG hướng dẫn dùng lệnh '• */DeliverDocument* — Đăng ký chuyển phát hồ sơ'. TUYỆT ĐỐI KHÔNG IN LINK FORM HOẶC SHEET, KHÔNG IN LẠI WELCOME MESSAGE VÀ CẤM IN DÒNG THÔNG BÁO CHẤM CÔNG!\n" +
      "- Khi hỏi 'hướng dẫn chấm điểm' hoặc 'chấm điểm nhân viên': CHỈ TRẢ LỜI 1 DÒNG hướng dẫn dùng lệnh '• */Penalty&Bonus* — Chấm điểm cho nhân viên'. TUYỆT ĐỐI KHÔNG IN LINK FORM HOẶC SHEET!\n" +
      "- **QUY TẮC NÂNG CAO — KHI HỎI CÁCH THẢ TIM / THẢ BOM / CHO ĐIỂM / CHẤM PENALTY & BONUS CHO NGƯỜI KHÁC:**\n" +
      "  Nếu người dùng hỏi cách cho tim/bom/điểm cho ai đó (ví dụ 'Tôi muốn thả 1 tim cho Thủy Tiên thì làm thế nào?'), BẮT BUỘC hướng dẫn theo đúng chuẩn 2 cách sau:\n" +
      "  1. **Gõ lệnh trực tiếp trong chat:** `*/Penalty&Bonus @[Tên/Tag người dùng] +1 [Lý do]*` (Gõ `/Penalty&Bonus` rồi tag `@Tên` hoặc gõ `NickName` của người đó). Ví dụ: `*/Penalty&Bonus @Thủy Tiên +1 Hỗ trợ nhiệt tình*` hoặc `*/Penalty&Bonus 200.Tien +1 Hỗ trợ nhiệt tình*`.\n" +
      "  2. **Dùng biểu mẫu (Dialog):** Gõ `*/Penalty&Bonus*` (không kèm tham số) ➔ Chọn tên nhân viên trong danh sách ➔ Chọn số điểm (+1 / -1...) ➔ Nhập lý do.\n" +
      "  ❌ **CẤM TUYỆT ĐỐI:** CẤM hướng dẫn tag email (@email) vì hệ thống 200 AI chấm điểm bằng **TÊN/TAG NGƯỜI DÙNG** hoặc **NICK NAME**! CẤM tự sáng tác cú pháp lạ như `++/Penalty&Bonus`, `++/CEO.Son`, `+/...` hay bất kỳ cú pháp sai chuẩn nào!\n" +
      "- **QUY TẮC CỐT LÕI VỀ CHÍNH XÁC THÔNG TIN (CẤM BỊA ĐẶT):** Nếu bạn không biết câu trả lời hoặc không tìm thấy dữ liệu trong các nguồn được cung cấp, chỉ cần nói rằng bạn không biết, đừng cố bịa ra câu trả lời cho tôi.\n" +
      "- Riêng câu hỏi thực sự về đi muộn, về sớm, quên chấm công hoặc phạt trừ công thì mới vào mục 'Dữ Liệu Chấm Công' kết hợp 'Quy Định Công Ty' và xử lý theo yêu cầu sau: " + promtp1;

    var answer = sendtoGemini(promtp)

    // Chuyển **text** (Markdown chuẩn) → *text* (Google Chat bold syntax)
    answer = answer.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')

    logUserIngestionAsync(event, "GENERAL_QA", message, answer, new Date().getTime() - startTime);
    return { "text": answer };

  } catch (error) {
    const space = event.space?.name;
    Logger.log('BUILD_ID=' + BUILD_ID);
    Logger.log('onMessage error: ' + (error && error.message ? error.message : String(error)));
    if (error && error.stack) Logger.log(error.stack);
    Logger.log('event snapshot: ' + JSON.stringify({
      type: event?.type,
      hasMessageText: typeof event?.message?.text === 'string',
      messageText: event?.message?.text,
      argumentText: event?.message?.argumentText,
      slashCommandId: event?.message?.slashCommand?.commandId,
      user: event?.user?.displayName,
      space: event?.space?.name
    }));

    // Ghi log nội bộ (không bắt buộc phải thành công)
    try {
      if (space) {
        sendMessageByChatBot(
          { text: '[' + BUILD_ID + '] ' + (error && error.message ? error.message : String(error)) },
          space
        );
      }
    } catch (e2) {
      Logger.log('Failed to send error notification: ' + e2.message);
    }

    // \u2705 LUON return { text } de Google Chat khong hien "khong phan hoi"
    return { "text": "\uD83D\uDE14 Xin l\u1ED7i, h\u1EC7 th\u1ED1ng \u0111ang g\u1EB7p s\u1EF1 c\u1ED1 nh\u1ECF. Anh/ch\u1ECB vui l\u00F2ng th\u1EED l\u1EA1i sau \u00EDt ph\u00fat ho\u1EB7c li\u00EAn h\u1EC7 ph\u00F2ng 200 \u0111\u1EC3 \u0111\u01B0\u1EE3c h\u1ED7 tr\u1EE3 \u1EA1!" };
  }
}

function getCurrentMonth() {
  const now = new Date();
  return now.getMonth() + 1;
}

function getCurrentDay() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return new Date(year, month + 1, 0).getDate();
}

function timeToMinutes(time) {
  if (!time && time !== 0) return null;

  // Date object (Google Sheets trả về khi ô định dạng Time)
  if (time instanceof Date) {
    return time.getHours() * 60 + time.getMinutes();
  }

  // Number (fractional day: 0.354 = 08:30) - Google Sheets đôi khi trả về dạng này
  if (typeof time === 'number') {
    var totalMinutes = Math.round(time * 24 * 60);
    return totalMinutes;
  }

  // String "08:30"
  if (typeof time === 'string' && time.includes(':')) {
    var parts = time.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  return null;
}

function testLastUpdatedDay() {
  const sheetID = '1ytMbWdEFGrAgyL0xKgp9OzTAOO62Sh7ma1WSOlFK2m4'
  const sheetName = 'Finger Print'

  var sourceSheet = SpreadsheetApp.openById(sheetID).getSheetByName(sheetName);
  var lastRow = sourceSheet.getLastRow();

  var dayColumn = sourceSheet.getRange(3, 2, lastRow - 3, 1).getDisplayValues(); // Cột B - lấy text hiển thị
  var timeInColumn = sourceSheet.getRange(3, 4, lastRow - 3, 1).getValues();
  var timeOutColumn = sourceSheet.getRange(3, 5, lastRow - 3, 1).getValues();
  var ten = sourceSheet.getRange(3, 16, 33, 1).getValues();

  var daysPerPerson = getCurrentDay();

  console.log('=== Tổng dòng dữ liệu: ' + dayColumn.length + ' | Số ngày trong tháng: ' + daysPerPerson + ' | Số nhân viên: ' + ten.length + ' ===');

  var maxWorkDays = 0;
  var bestPerson = '';
  var bestLatestDay = '';

  for (var p = 0; p < ten.length; p++) {
    var startIdx = p * daysPerPerson;
    var workDayCount = 0;
    var personLastDay = '';

    for (var d = 0; d < daysPerPerson && (startIdx + d) < timeInColumn.length; d++) {
      var idx = startIdx + d;
      if ((timeInColumn[idx][0] !== '' && timeInColumn[idx][0] !== null && timeInColumn[idx][0] !== undefined) ||
        (timeOutColumn[idx][0] !== '' && timeOutColumn[idx][0] !== null && timeOutColumn[idx][0] !== undefined)) {
        workDayCount++;
        personLastDay = dayColumn[idx][0]; // luôn ghi đè → cuối vòng lặp sẽ là ngày cuối cùng có data
      }
    }

    console.log('NV ' + (p + 1) + ': ' + ten[p][0] + ' | Số ngày đi làm: ' + workDayCount + ' | Ngày cuối: ' + (personLastDay || 'N/A'));

    if (workDayCount > maxWorkDays) {
      maxWorkDays = workDayCount;
      bestPerson = ten[p][0];
      bestLatestDay = personLastDay;
    }
  }

  console.log('=== KẾT QUẢ ===');
  console.log('Người đi làm nhiều nhất: ' + bestPerson + ' (' + maxWorkDays + ' ngày)');
  console.log('Ngày cập nhật: ' + bestLatestDay);
}

function getTimeStampData() {
  try {
    try {
      var cachedData = CacheService.getScriptCache().get("TIME_STAMP_DATA_CACHE_V2");
      if (cachedData) return cachedData;
    } catch (ce) { }

    const sheetID = '1ytMbWdEFGrAgyL0xKgp9OzTAOO62Sh7ma1WSOlFK2m4';
    const sheetName = 'Finger Print';

    var sourceSheet = null;
    try {
      sourceSheet = SpreadsheetApp.openById(sheetID).getSheetByName(sheetName);
    } catch (e) {
      Logger.log('Error opening spreadsheet in getTimeStampData: ' + e.message);
    }

    if (!sourceSheet) {
      return "Không có dữ liệu chấm công (Không tìm thấy sheet hoặc không có quyền truy cập).\n";
    }

    var lastRow = sourceSheet.getLastRow();
    var daysPerPerson = getCurrentDay();

    // ✅ Đọc tất cả dữ liệu 1 lần duy nhất
    var dataRows = lastRow - 2;
    if (dataRows <= 0) {
      return "Dữ liệu chấm công trống hoặc chưa bắt đầu.\n";
    }

    var allData = sourceSheet.getRange(3, 1, dataRows, 9).getValues();        // Cột A-I
    var allDataDisplay = sourceSheet.getRange(3, 2, dataRows, 1).getDisplayValues(); // Cột B display
    var summaryData = sourceSheet.getRange(3, 16, Math.max(1, dataRows), 5).getValues(); // Cột P-T

    // ✅ Build map tên → summary để lookup O(1)
    var summaryMap = {};
    for (var s = 0; s < summaryData.length; s++) {
      var tenNV = String(summaryData[s][0] || '').trim(); // Cột P
      if (tenNV) {
        var info = {
          muon: summaryData[s][1], // Cột Q
          quen: summaryData[s][2], // Cột R
          cong: summaryData[s][3], // Cột S
          sophutmuon: summaryData[s][4]  // Cột T
        };
        summaryMap[tenNV] = info;
        summaryMap[tenNV.toLowerCase()] = info;
      }
    }

    // ✅ Tìm ngày cập nhật cuối — duyệt 1 lần
    var maxWorkDays = 0;
    var lastUpdatedDay = 'Chưa có dữ liệu';

    for (var p = 0; p < summaryData.length; p++) {
      var startIdx = p * daysPerPerson;
      var workDayCount = 0;
      var personLastDay = '';

      for (var d = 0; d < daysPerPerson && (startIdx + d) < dataRows; d++) {
        var idx = startIdx + d;
        var tIn = allData[idx][3]; // Cột D
        var tOut = allData[idx][4]; // Cột E
        if ((tIn !== '' && tIn != null) ||
          (tOut !== '' && tOut != null)) {
          workDayCount++;
          personLastDay = allDataDisplay[idx][0];
        }
      }

      if (workDayCount > maxWorkDays) {
        maxWorkDays = workDayCount;
        lastUpdatedDay = personLastDay || 'Chưa có dữ liệu';
      }
    }

    var stringObj = 'Dữ liệu chấm công tháng ' + getCurrentMonth() +
      ' của nhân viên (Dữ liệu được cập nhật đến ngày: ' + lastUpdatedDay + '). \n';

    var stack = 0;
    var currentName = '';

    for (var i = 0; i < dataRows; i++) {
      var nameVal = allData[i][0]; // Cột A
      var dayVal = allDataDisplay[i][0];
      var timeIn = allData[i][3]; // Cột D
      var timeOut = allData[i][4]; // Cột E
      var request = allData[i][5]; // Cột F
      var detail = allData[i][8]; // Cột I

      // ✅ In header nhân viên khi đến stack mới (LUÔN IN HEADER DÙ CÓ SUMMARY HAY KHÔNG)
      if (i === stack) {
        currentName = String(nameVal || '').trim();
        if (!currentName) {
          for (var k = 0; k < daysPerPerson && (i + k) < dataRows; k++) {
            if (allData[i + k][0]) {
              currentName = String(allData[i + k][0]).trim();
              break;
            }
          }
        }
        var sm = summaryMap[currentName] || summaryMap[currentName.toLowerCase()];
        stringObj += '\n--------------------\nTên nhân viên: ' + (currentName || ('NhanVien_' + (stack / daysPerPerson + 1)));
        if (sm) {
          stringObj += ', Số lần muộn: ' + sm.muon +
            ', Số lần quên: ' + sm.quen +
            ', Tổng công: ' + sm.cong +
            ', Số phút muộn: ' + sm.sophutmuon;
        }
        stringObj += '. Chi tiết từng ngày:\n';
        stack += daysPerPerson;
      }

      // ✅ Swap nếu timeIn thực ra là buổi chiều muộn
      var timeInMinutes = timeToMinutes(timeIn);
      if (timeInMinutes !== null && timeInMinutes > timeToMinutes('16:00')) {
        timeOut = timeIn;
        timeIn = '';
      }

      if (timeIn || timeOut || request || detail) {
        stringObj += 'Ngày:' + dayVal +
          ', Check in: ' + timeIn +
          ', Checkout: ' + timeOut +
          ', *Lý do: ' + request +
          ', *Ghi chú:* ' + detail + '\n';
      }
    }

    try {
      CacheService.getScriptCache().put("TIME_STAMP_DATA_CACHE_V2", stringObj, 180); // Cache 3 phút
    } catch (ce) { }

    return stringObj;
  } catch (error) {
    Logger.log('Error in getTimeStampData: ' + error.message);
    return "Không có dữ liệu chấm công do lỗi hệ thống.\n";
  }
}

/**
 * Lấy tổng số tim (hearts) và tổng số bom (bombs) tích luỹ của từng nhân viên.
 * Trả về object { stdName: { hearts: number, bombs: number, total: number } }
 * (VD: { "VPA.Duong": { hearts: 7, bombs: 2, total: 5 } }).
 */
function getEmployeeTotalScores(usePrivate) {
  try {
    var targetId = usePrivate ? PRIVATE_SPREADSHEET_ID : SPREADSHEET_ID;
    var ss = SpreadsheetApp.openById(targetId);
    var scoreMap = {};

    // 1. Đọc dữ liệu chi tiết từ sheet Data (hoặc Merge Data) để tính tổng tim và bom tích lũy
    var dataSheet = ss.getSheetByName(SHEET_NAME) || ss.getSheetByName('Merge Data');
    if (dataSheet) {
      var lastRow = getLastRowInColumn(dataSheet, 1);
      if (lastRow > 1) {
        var logs = dataSheet.getRange(2, 1, lastRow - 1, 5).getValues();
        for (var i = 0; i < logs.length; i++) {
          var name = String(logs[i][2] || '').trim();
          var pt = Number(logs[i][4]);
          if (!name || isNaN(pt)) continue;
          if (name.includes("Nhân viên") || name.includes("Staff") || name.includes("Name") || name.includes("Tên")) continue;

          if (!scoreMap[name]) {
            scoreMap[name] = { hearts: 0, bombs: 0, total: 0 };
          }
          if (pt > 0) {
            scoreMap[name].hearts += pt;
          } else if (pt < 0) {
            scoreMap[name].bombs += Math.abs(pt);
          }
          scoreMap[name].total = scoreMap[name].hearts - scoreMap[name].bombs;
        }
      }
    }

    // 2. Đối chiếu/Cập nhật từ bảng tổng kết DashBoard hoặc Merge Data nếu có
    var summarySheet = ss.getSheetByName('DashBoard') || ss.getSheetByName('Merge Data');
    if (summarySheet) {
      var lastRowSum = getLastRowInColumn(summarySheet, 1);
      if (lastRowSum > 1) {
        var summaryData = summarySheet.getRange(1, 1, lastRowSum, 4).getValues();
        for (var k = 0; k < summaryData.length; k++) {
          var sName = String(summaryData[k][0] || '').trim();
          if (!sName || sName.includes("Nick Name") || sName.includes("Staff") || sName.includes("Name") || sName.includes("Tên") || sName.includes("Sum")) continue;

          var bomVal = Math.abs(Number(summaryData[k][2]));
          var timVal = Number(summaryData[k][3]);

          if (!isNaN(timVal) && !isNaN(bomVal) && (timVal > 0 || bomVal > 0)) {
            scoreMap[sName] = {
              hearts: timVal,
              bombs: bomVal,
              total: timVal - bomVal
            };
          }
        }
      }
    }

    return scoreMap;
  } catch (error) {
    Logger.log('Error in getEmployeeTotalScores: ' + error.message);
    return {};
  }
}

/**
 * Tạo chuỗi "Total until Now" hiển thị tách biệt tổng tim và tổng bom.
 * @param {string[]} selectedEmployees - Danh sách tên nhân viên.
 * @param {Object} scoreMap - Điểm hiện tại TRƯỚC KHI ghi.
 * @param {number} addedPoint - Điểm vừa chấm (VD: +1, -3). Cộng thêm vào tim/bom.
 * VD 1 người: "\nTotal until Now: 7 ❤️ ; 2 Bom"
 */
function formatTotalLine(selectedEmployees, scoreMap, addedPoint) {
  var parts = [];
  var pt = Number(addedPoint) || 0;

  for (var i = 0; i < selectedEmployees.length; i++) {
    var empName = selectedEmployees[i];
    var empData = (scoreMap && scoreMap[empName]) ? scoreMap[empName] : null;

    var oldHearts = 0;
    var oldBombs = 0;

    if (typeof empData === 'object' && empData !== null) {
      oldHearts = Number(empData.hearts) || 0;
      oldBombs = Number(empData.bombs) || 0;
    } else if (typeof empData === 'number') {
      if (empData >= 0) oldHearts = empData;
      else oldBombs = Math.abs(empData);
    }

    var newHearts = oldHearts;
    var newBombs = oldBombs;

    if (pt > 0) {
      newHearts += pt;
    } else if (pt < 0) {
      newBombs += Math.abs(pt);
    }

    var display = newHearts + ' ❤️ ; ' + newBombs + ' 💣';
    if (selectedEmployees.length === 1) {
      parts.push(display);
    } else {
      parts.push(empName + ': ' + display);
    }
  }

  if (parts.length === 0) return '';
  return '\n*Total until Now:* ' + parts.join(' | ');
}

function getPenaltyData() {
  try {
    var detailsStr = "";
    var targetIds = [SPREADSHEET_ID, PRIVATE_SPREADSHEET_ID];

    for (var j = 0; j < targetIds.length; j++) {
      try {
        var ss = SpreadsheetApp.openById(targetIds[j]);
        var dataSheet = ss.getSheetByName(SHEET_NAME) || ss.getSheetByName('Merge Data') || ss.getSheetByName('Data');
        if (dataSheet) {
          var lastRow = getLastRowInColumn(dataSheet, 1);
          if (lastRow > 1) {
            var logs = dataSheet.getRange(2, 1, lastRow - 1, 5).getValues();
            var detailsArr = [];
            for (var i = 0; i < logs.length; i++) {
              var evaluator = safeTrim(logs[i][0]);
              var timeVal = logs[i][1];
              var empName = safeTrim(logs[i][2]);
              var reason = safeTrim(logs[i][3]);
              var pt = Number(logs[i][4]);

              if (!empName || isNaN(pt)) continue;
              if (empName.includes("Nhân viên") || empName.includes("Staff") || empName.includes("Name") || empName.includes("Tên")) continue;

              var formattedTime = timeVal ? convertDateToVietnamFormat(timeVal) : '';
              var ptStr = pt > 0 ? ('+' + pt + ' ❤️') : (pt + ' 💣');

              detailsArr.push(`- Ngày ${formattedTime}: Người đánh giá [${evaluator}] ➔ Chấm [${empName}] ${ptStr}. Lý do: "${reason || 'Không có'}"`);
            }
            if (detailsArr.length > 0) {
              detailsStr = "Lịch sử chi tiết các lần đánh giá Penalty & Bonus (Người đánh giá, Người nhận điểm, Ngày giờ, Loại điểm, Lý do):\n" + detailsArr.join('\n') + "\n\n";
              break;
            }
          }
        }
      } catch (eTarget) {
        Logger.log('Target sheet read error: ' + eTarget.message);
      }
    }

    var scoreMap = getEmployeeTotalScores(false);
    if (!scoreMap || Object.keys(scoreMap).length === 0) {
      scoreMap = getEmployeeTotalScores(true);
    }

    var gross = "Tổng kết điểm tích lũy (Số tim ❤️, Số bom 💣):\n";
    for (var name in scoreMap) {
      var info = scoreMap[name];
      gross += 'Nhân Viên: ' + name + ', tổng tim: ' + info.hearts + ' ❤️, tổng bom: ' + info.bombs + ' 💣\n';
    }

    return detailsStr + gross;
  } catch (error) {
    Logger.log('Error in getPenaltyData: ' + error.message);
    return '';
  }
}

function convertDateToVietnamFormat(dateInput) {
  // Parse nếu là string
  var date = (typeof dateInput === 'string') ? new Date(dateInput) : dateInput;

  // Tính giờ Việt Nam (GMT+7)
  var utc = date.getTime() + (date.getTimezoneOffset() * 60000); // UTC timestamp
  var vietnamDate = new Date(utc + (7 * 60 * 60000)); // +7 giờ

  // Format thành chuỗi dd/MM/yyyy HH:mm:ss
  var day = String(vietnamDate.getDate()).padStart(2, '0');
  var month = String(vietnamDate.getMonth() + 1).padStart(2, '0'); // tháng bắt đầu từ 0
  var year = vietnamDate.getFullYear();

  var hours = String(vietnamDate.getHours()).padStart(2, '0');
  var minutes = String(vietnamDate.getMinutes()).padStart(2, '0');
  var seconds = String(vietnamDate.getSeconds()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}


// function compareStaff(name) {
//   var standname = getSheetDataRange(8, 8, 2, getLastRowInColumn(8))
//   var staff = getSheetDataRange(9, 9, 2, getLastRowInColumn(9))
//   var position = getSheetDataRange(10, 10, 2, getLastRowInColumn(10))

//   for(var i = 0; i < staff.length; i++) {
//     if(staff[i][0] == name) {
//       return [standname[i][0], position[i][0]]
//     }
//   }

//   return [null, null]
// }

function dayreturn() {
  var today = new Date();

  var dd = String(today.getDate()).padStart(2, '0');
  var mm = String(today.getMonth() + 1).padStart(2, '0'); // Tháng bắt đầu từ 0
  var yyyy = today.getFullYear();

  var formattedDate = `${dd}/${mm}/${yyyy}`;
  return formattedDate;
}

/**
 * Danh sách model fallback theo thứ tự ưu tiên.
 * Khi model chính bị rate limit (429) hoặc server busy (503) hoặc timeout,
 * hệ thống sẽ tự động chuyển sang model tiếp theo trong danh sách.
 * LƯU Ý: deadlineMs phải nhỏ hơn timeoutMs để UrlFetchApp thoát trước khi GAS timeout tổng (6 phút).
 * Với Add-on Google Chat, execution limit thực tế ~30s → đặt deadline thấp để còn thời gian fallback.
 */
var FALLBACK_MODELS = [
  { name: "gemini-3.1-flash-lite", timeoutMs: 8000, deadlineMs: 6 },  // Model chính - chạy ổn định
  { name: "gemini-2.5-flash-lite", timeoutMs: 8000, deadlineMs: 6 },  // Backup 1
  { name: "gemini-3.5-flash-lite", timeoutMs: 8000, deadlineMs: 6 },  // Backup 2
  { name: "gemini-2.5-flash", timeoutMs: 8000, deadlineMs: 6 },       // Backup 3
];

/**
 * Gọi 1 model Gemini cụ thể. Trả về object { success, text, shouldFallback, error }.
 * - success: true nếu lấy được response hợp lệ
 * - text: nội dung phản hồi (khi success=true)
 * - shouldFallback: true nếu lỗi thuộc loại rate limit / server busy / timeout → nên thử model khác
 * - error: thông tin lỗi để log
 * @param {number} deadlineMs - deadline tính bằng GIÂY truyền vào UrlFetchApp (GAS dùng đơn vị giây)
 */
function callGeminiModel(prompt, modelName, apiKey, timeoutMs, deadlineMs) {
  var payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  // deadline (đơn vị giây) buộc UrlFetchApp thoát sớm → còn thời gian để thử model backup
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,  // Không throw exception khi HTTP != 2xx, để ta tự xử lý status code
    deadline: deadlineMs || 18  // timeout fetch theo giây (GAS default là 60s - quá dài)
  };

  try {
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + apiKey;

    // Đo thời gian bắt đầu để kiểm tra timeout
    var startTime = new Date().getTime();
    var response = UrlFetchApp.fetch(url, options);
    var elapsed = new Date().getTime() - startTime;

    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    // Kiểm tra nếu thời gian phản hồi vượt quá timeout cho phép (server quá chậm)
    if (elapsed >= timeoutMs) {
      Logger.log("[Fallback] Model " + modelName + " phản hồi quá chậm (" + elapsed + "ms >= " + timeoutMs + "ms). Chuyển model...");
      return { success: false, text: null, shouldFallback: true, error: "Timeout: " + elapsed + "ms" };
    }

    // Rate Limit (429) hoặc Server Overloaded/Busy (503/502) → fallback sang model khác
    if (responseCode === 429) {
      Logger.log("[Fallback] Model " + modelName + " bị rate limit (HTTP 429). Chuyển model...");
      return { success: false, text: null, shouldFallback: true, error: "Rate limit 429" };
    }
    if (responseCode === 503 || responseCode === 502) {
      Logger.log("[Fallback] Model " + modelName + " server busy (HTTP " + responseCode + "). Chuyển model...");
      return { success: false, text: null, shouldFallback: true, error: "Server busy " + responseCode };
    }
    // 500 Internal Server Error → fallback
    if (responseCode === 500) {
      Logger.log("[Fallback] Model " + modelName + " internal server error (HTTP 500). Chuyển model...");
      return { success: false, text: null, shouldFallback: true, error: "Internal server error 500" };
    }
    // 404 → Model không còn khả dụng với user này → fallback sang model khác
    if (responseCode === 404) {
      Logger.log("[Fallback] Model " + modelName + " không khả dụng (HTTP 404 - model unavailable). Chuyển model...");
      return { success: false, text: null, shouldFallback: true, error: "Model unavailable 404" };
    }

    // Các lỗi 4xx khác (400 Bad Request, 403 Forbidden) → không fallback vì lỗi do input/API key
    if (responseCode >= 400 && responseCode < 500) {
      Logger.log("[Error] Model " + modelName + " trả về HTTP " + responseCode + ": " + responseText);
      return { success: false, text: null, shouldFallback: false, error: "HTTP " + responseCode };
    }

    // Kiểm tra nếu body chứa lỗi RESOURCE_EXHAUSTED (Google API đôi khi trả HTTP 200 nhưng body có error)
    if (responseText.indexOf("RESOURCE_EXHAUSTED") !== -1 || responseText.indexOf("rateLimitExceeded") !== -1) {
      Logger.log("[Fallback] Model " + modelName + " bị RESOURCE_EXHAUSTED trong response body. Chuyển model...");
      return { success: false, text: null, shouldFallback: true, error: "RESOURCE_EXHAUSTED in body" };
    }

    // Parse JSON và trích xuất text
    var json = JSON.parse(responseText);
    var text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ??
      json?.candidates?.[0]?.content?.parts?.map(function (p) { return p?.text; }).filter(Boolean).join('\n');

    if (typeof text === 'string' && text.trim()) {
      return { success: true, text: text.trim(), shouldFallback: false, error: null };
    } else {
      // Model trả về nhưng không có nội dung hữu ích → thử model khác
      Logger.log("[Fallback] Model " + modelName + " trả về response rỗng. Chuyển model...");
      return { success: false, text: null, shouldFallback: true, error: "Empty response" };
    }

  } catch (e) {
    // Lỗi network, timeout của UrlFetchApp, v.v. → fallback
    Logger.log("[Fallback] Model " + modelName + " exception: " + e.message);
    // Kiểm tra nếu lỗi liên quan đến timeout hoặc network
    var errMsg = (e.message || "").toLowerCase();
    if (errMsg.indexOf("timeout") !== -1 || errMsg.indexOf("timed out") !== -1 ||
      errMsg.indexOf("deadline") !== -1 || errMsg.indexOf("address unavailable") !== -1 ||
      errMsg.indexOf("502") !== -1 || errMsg.indexOf("503") !== -1 ||
      errMsg.indexOf("rate") !== -1 || errMsg.indexOf("quota") !== -1 ||
      errMsg.indexOf("resource") !== -1) {
      return { success: false, text: null, shouldFallback: true, error: e.message };
    }
    // Lỗi khác (ví dụ JSON parse fail) → vẫn thử fallback
    return { success: false, text: null, shouldFallback: true, error: e.message };
  }
}

/**
 * Gửi prompt đến Gemini với cơ chế tự động fallback qua nhiều model.
 * Thứ tự thử: gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.0-flash → gemini-2.0-flash-lite
 * Chuyển model khi gặp: rate limit (429), server busy (503), timeout, hoặc response rỗng.
 * FIX BACKUP: Mỗi model có deadline riêng (giây) truyền vào UrlFetchApp để thoát sớm,
 * còn đủ thời gian GAS thử model tiếp theo trước khi bị cắt execution (30s limit của Chat Add-on).
 */
function sendtoGemini(prompt) {
  var API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

  var lastError = "";

  for (var i = 0; i < FALLBACK_MODELS.length; i++) {
    var model = FALLBACK_MODELS[i];
    Logger.log("[AI] Đang thử model: " + model.name + " (timeout: " + model.timeoutMs + "ms, deadline: " + model.deadlineMs + "s)");

    var result = callGeminiModel(prompt, model.name, API_KEY, model.timeoutMs, model.deadlineMs);

    if (result.success) {
      if (i > 0) {
        Logger.log("[AI] ✅ Fallback thành công! Đã dùng model backup: " + model.name + " (thay vì " + FALLBACK_MODELS[0].name + ")");
      }
      return result.text;
    }

    lastError = result.error || "Unknown error";

    // Nếu lỗi không thuộc loại nên fallback (ví dụ 400, 403) → dừng ngay, không thử model khác
    if (!result.shouldFallback) {
      Logger.log("[AI] ❌ Lỗi không thể fallback ở model " + model.name + ": " + lastError);
      break;
    }

    // Không sleep giữa các lần fallback - tiết kiệm thời gian execution
    Logger.log("[AI] ⚠️ Model " + model.name + " thất bại (" + lastError + "). Chuyển sang model tiếp theo...");
  }

  Logger.log("[AI] ❌ Tất cả model đều thất bại. Lỗi cuối: " + lastError);
  return "200 AI đang gặp sự cố. Anh/Chị vui lòng thử lại sau ít phút ạ...!";
}

//=============================================================================================================================================

function fetchGemsData() {
  // Replace with the actual URL for the GEMS API endpoint.
  // Note: Most GEMS APIs will require authentication.
  var gemsApiUrl = 'https://api.cgs-gems.com/data/ed6e3ac98d36';

  // Define any necessary headers, such as for OAuth authentication.
  // Replace `YOUR_ACCESS_TOKEN` with a real token.
  var options = {
    'method': 'GET',
    'headers': {
      'Authorization': 'Bearer ' + PropertiesService.getScriptProperties().getProperty('GEMS_API_KEY')
    },
    'muteHttpExceptions': true
  };

  try {
    var response = UrlFetchApp.fetch(gemsApiUrl, options);
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (responseCode === 200) {
      // Parse the JSON data from the response.
      var data = JSON.parse(responseText);

      // Log the data to view it.
      Logger.log(data);

    } else {
      Logger.log('API Request failed. Response Code: ' + responseCode);
      Logger.log('Response: ' + responseText);
    }
  } catch (e) {
    Logger.log('An error occurred: ' + e.message);
  }
}



//=============================================================================================================================================

function getCompanyRules() {
  // Document gốc đã bị xóa, chuyển sang dùng companyRule() hardcoded
  return companyRule();
}

/**
 * Trích xuất danh sách tài liệu, link và nội dung từ Thư mục 210. Documents Management
 * Bao gồm: 211 (Company Legal Documents), 212 (Reporting contract), 213 (Passport/Visa), 214→219...
 */
/**
 * 💾 LƯU BỘ NHỚ ĐỆM DỮ LIỆU DUNG LƯỢNG LỚN (LƯU VÀO GOOGLE SHEET & CHUNKING PROPERTIES)
 * Chống lỗi 50,000 ký tự / cell của Google Sheet & lỗi 9KB của PropertiesService.
 */
function saveLegalDocsCache(text) {
  if (!text) return;

  // 1. Lưu vào Google Sheet dưới dạng các HÀNG (Rows) trong Cột A (Tránh vượt quá 50,000 ký tự / cell)
  try {
    var ssId = typeof INGESTION_LOG_SPREADSHEET_ID !== 'undefined' ? INGESTION_LOG_SPREADSHEET_ID : '10Bb29mvsPseVmNySShF93hejqCxpJRon0YC2-NyMBnQ';
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("Legal_Docs_Cache");
    if (!sheet) {
      sheet = ss.insertSheet("Legal_Docs_Cache");
    }
    sheet.clearContents();

    var lines = text.split('\n');
    var rows = lines.map(function (line) {
      var strLine = String(line || '');
      return [strLine.length > 40000 ? strLine.substring(0, 40000) : strLine];
    });

    if (rows.length > 0) {
      sheet.getRange(1, 1, rows.length, 1).setValues(rows);
    }
  } catch (se) {
    Logger.log("saveLegalDocsCache Sheet error: " + se.message);
  }

  // 2. Phân mảnh Chunking vào PropertiesService (Mỗi mảnh 8,000 ký tự)
  try {
    var props = PropertiesService.getScriptProperties();
    var CHUNK_SIZE = 8000;
    var totalChunks = Math.ceil(text.length / CHUNK_SIZE);
    props.setProperty("LEGAL_DOCS_CHUNK_COUNT", totalChunks.toString());
    for (var c = 0; c < Math.min(totalChunks, 40); c++) {
      var chunk = text.substring(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
      props.setProperty("LEGAL_DOCS_CHUNK_" + c, chunk);
    }
  } catch (pe) {
    Logger.log("saveLegalDocsCache Properties error: " + pe.message);
  }
}

/**
 * 📖 ĐỌC BỘ NHỚ ĐỆM DỮ LIỆU DUNG LƯỢNG LỚN
 */
function loadLegalDocsCache() {
  // 1. Đọc từ PropertiesService (Chunking)
  try {
    var props = PropertiesService.getScriptProperties();
    var countStr = props.getProperty("LEGAL_DOCS_CHUNK_COUNT");
    if (countStr) {
      var count = parseInt(countStr);
      var result = "";
      for (var i = 0; i < count; i++) {
        var chunk = props.getProperty("LEGAL_DOCS_CHUNK_" + i);
        if (chunk) result += chunk;
      }
      if (result && result.trim() !== "") return result;
    }
  } catch (pe) { }

  // 2. Dự phòng: Đọc từ tab Sheet "Legal_Docs_Cache" (Các hàng Cột A)
  try {
    var ssId = typeof INGESTION_LOG_SPREADSHEET_ID !== 'undefined' ? INGESTION_LOG_SPREADSHEET_ID : '10Bb29mvsPseVmNySShF93hejqCxpJRon0YC2-NyMBnQ';
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName("Legal_Docs_Cache");
    if (sheet) {
      var values = sheet.getDataRange().getValues();
      if (values && values.length > 0) {
        var lines = values.map(function (r) { return r[0]; });
        var text = lines.join('\n');
        if (text && text.trim() !== "") return text;
      }
    }
  } catch (se) { }

  return null;
}

function getFolder211LegalDocsData() {
  try {
    var cacheKey = "LEGAL_DOCS_211_CACHE_V2";
    try {
      var cached = CacheService.getScriptCache().get(cacheKey);
      if (cached) return cached;
    } catch (ce) { }

    // 1. Ưu tiên lấy từ bộ lưu trữ vĩnh viễn (được quét tự động ngầm qua Trigger)
    var permCached = loadLegalDocsCache();
    if (permCached && permCached.trim() !== "") {
      try { CacheService.getScriptCache().put(cacheKey, permCached.substring(0, 90000), 21600); } catch (e) { }
      return permCached;
    }

    // 2. Nếu chưa có dữ liệu quét ngầm, tiến hành quét nhanh trực tiếp trong giới hạn an toàn (<2.5s)
    var folderId = '0B_q5HyYkeLftU1NNSzhDWnRYVzA'; // Folder 210. Documents Management
    var parentFolder = null;
    try {
      parentFolder = DriveApp.getFolderById(folderId);
    } catch (fe) {
      Logger.log("getFolder211LegalDocsData parentFolder error: " + fe.message);
      return "Không thể truy cập Thư mục 211 (ID: " + folderId + ") hoặc chưa cấp quyền DriveApp.\n";
    }

    if (!parentFolder) return "";

    var lines = [];
    lines.push("------------------- Danh sách Văn bản / Tài liệu Thư mục 210 (Documents Management: 211→219) -------------------");

    var startTime = new Date().getTime();
    var fileCount = 0;

    function scanFolder(folder, pathPrefix) {
      if (!folder) return;
      if (new Date().getTime() - startTime > 2500 || fileCount >= 40) return; // Chặn timeout 2.5s khi chạy trực tiếp

      try {
        var files = folder.getFiles();
        while (files && files.hasNext()) {
          if (new Date().getTime() - startTime > 2500 || fileCount >= 40) break;
          try {
            var file = files.next();
            if (!file) continue;
            var fName = file.getName();
            var fUrl = file.getUrl();
            var fMime = file.getMimeType();
            var fullPath = pathPrefix ? (pathPrefix + " > " + fName) : fName;

            var textContent = "";
            if (fMime === MimeType.GOOGLE_DOCS) {
              try {
                var doc = DocumentApp.openById(file.getId());
                if (doc) textContent = doc.getBody().getText();
              } catch (de) { }
            }

            lines.push("- Tài liệu: \"" + fName + "\" | Vị trí công ty/bộ phận: " + fullPath);
            lines.push("  Link xem: " + fUrl);
            if (textContent) {
              var snippet = textContent.replace(/\s+/g, ' ').substring(0, 1000);
              lines.push("  Trích yếu nội dung: " + snippet);
            }
            fileCount++;
          } catch (fileErr) {
            Logger.log("Error processing individual file in " + pathPrefix + ": " + fileErr.message);
          }
        }
      } catch (filesErr) {
        Logger.log("Error getting files in " + pathPrefix + ": " + filesErr.message);
      }

      try {
        var subFolders = folder.getFolders();
        while (subFolders) {
          if (new Date().getTime() - startTime > 2500 || fileCount >= 40) break;
          try {
            if (!subFolders.hasNext()) break;
            var sub = subFolders.next();
            if (!sub) continue;
            var subName = sub.getName();
            var newPrefix = pathPrefix ? (pathPrefix + " > " + subName) : subName;
            scanFolder(sub, newPrefix);
          } catch (subErr) {
            Logger.log("Error processing subfolder in " + pathPrefix + ": " + subErr.message);
          }
        }
      } catch (subsErr) {
        Logger.log("Error getting subfolders in " + pathPrefix + ": " + subsErr.message);
      }
    }

    scanFolder(parentFolder, "210. Documents Management");

    var resultText = lines.join('\n');
    saveLegalDocsCache(resultText);

    return resultText;
  } catch (error) {
    Logger.log("Error in getFolder211LegalDocsData: " + error.toString());
    return "Không thể truy cập Thư mục 211 (1oDhTJUEmdICreryjojxuMisUVXT09jPD) hoặc thiếu quyền Drive.\n";
  }
}

/**
 * 🔄 HÀM QUÉT NGẦM KHÔNG GIỚI HẠN THỜI GIAN (BẰNG TRIGGER TỰ ĐỘNG)
 * Chạy ngầm trên máy chủ Google Apps Script (tối đa 6 phút), không bị giới hạn 30s của Google Chat!
 */
function refreshLegalDocsCacheTrigger() {
  Logger.log("[Background Trigger] 🔄 Bắt đầu quét toàn bộ Thư mục 210 ngầm...");
  var folderId = '0B_q5HyYkeLftU1NNSzhDWnRYVzA';
  var parentFolder = null;
  try { parentFolder = DriveApp.getFolderById(folderId); } catch (e) { return; }
  if (!parentFolder) return;

  var lines = [];
  lines.push("------------------- Danh sách Văn bản / Tài liệu Thư mục 210 (Documents Management: 211→219) -------------------");

  function scanFolderFull(folder, pathPrefix) {
    if (!folder) return;
    try {
      var files = folder.getFiles();
      while (files && files.hasNext()) {
        try {
          var file = files.next();
          if (!file) continue;
          var fName = file.getName();
          var fUrl = file.getUrl();
          var fMime = file.getMimeType();
          var fullPath = pathPrefix ? (pathPrefix + " > " + fName) : fName;

          var textContent = "";
          if (fMime === MimeType.GOOGLE_DOCS) {
            try {
              var doc = DocumentApp.openById(file.getId());
              if (doc) textContent = doc.getBody().getText();
            } catch (de) { }
          }

          lines.push("- Tài liệu: \"" + fName + "\" | Vị trí công ty/bộ phận: " + fullPath);
          lines.push("  Link xem: " + fUrl);
          if (textContent) {
            var snippet = textContent.replace(/\s+/g, ' ').substring(0, 1000);
            lines.push("  Trích yếu nội dung: " + snippet);
          }
        } catch (e) { }
      }
    } catch (e) { }

    try {
      var subFolders = folder.getFolders();
      while (subFolders && subFolders.hasNext()) {
        var sub = subFolders.next();
        if (sub) scanFolderFull(sub, pathPrefix ? (pathPrefix + " > " + sub.getName()) : sub.getName());
      }
    } catch (e) { }
  }

  scanFolderFull(parentFolder, "210. Documents Management");
  var resultText = lines.join('\n');

  try {
    saveLegalDocsCache(resultText);
    Logger.log("[Background Trigger] ✅ Đã hoàn tất quét ngầm toàn bộ Thư mục 210! Đã lưu vĩnh viễn dữ liệu (" + resultText.length + " ký tự) vào Google Sheet & Properties.");
  } catch (e) {
    Logger.log("[Background Trigger] Error saving cache: " + e.message);
  }
}

/**
 * ⏰ THIẾT LẬP TRIGGER TỰ ĐỘNG QUÉT NGẦM MỖI 1 GIỜ
 */
function setupLegalDocsHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'refreshLegalDocsCacheTrigger') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('refreshLegalDocsCacheTrigger')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log("✅ Đã tạo Trigger quét ngầm tự động mỗi 1 giờ!");
}

/*
function handleMonthlyInformation(response, name) {
  var ruleId = '13d-6vmeOTo7iKcm10xykTCWN7by5im8_lRPzDoD71uo'
  var dataId = '1Nd3Yq5HVD6dx5Igy7nGBk355b_ousGoR_EN4zptMAfs'

  var bodyRule = DocumentApp.openById(ruleId).getBody();
  var bodyData = DocumentApp.openById(dataId).getBody();

  var stringObj = bodyRule.getText() + '\n' + bodyData.getText()

  var promtp = "Đây là câu hỏi mà người dùng muốn hỏi về dữ liệu chấm công trong tháng của họ và có thể của người khác. Bạn cần phân tích câu hỏi để xem nội dung câu hỏi có tên không, nếu có tên trong câu hỏi thì lấy nó làm đối tượng để đổi chiếu với data. Nếu không có tên thì hãy lấy " + name + " làm đối tượng để đối chiếu nhé. Nếu sau đối chiếu mà không có dữ liệu thì trả về 'Không tìm thấy dữ liệu'. Trong data, trường detail sẽ có thế có dữ liệu là 'Muộn Muộn' thì cái đấy tính muộn 2 lần nhé. Nếu người dùng hỏi muộn hoặc quên thì . Chỉ trả về thông tin cần thiết nhưng phải lễ phép nha, đừng giải thích gì nhiều. Data để đối chiếu: " + JSON.stringify(stringObj) + ". Hãy đối chiếu data đấy để cung cấp đủ thông tin cho người dùng ví dụ muộn mấy lần, giờ kèm theo ngày cụ thể luôn nhé, có request xin phép thì phải nêu ra, vân vân (các chi tiết về từng lần muộn), dựa vào detail để biết quên, muộn ngày nào, còn số lần thì dựa vào soLanMuon, soLanQuen, tuyệt đối không được tính detail vào số lần đi muộn, quên và chi tiết ngày giờ cập nhật dữ liệu chấm công. Câu hỏi là: " + JSON.stringify(response) + ". Sau khi thu thập data liên quan tới câu hỏi, thì hãy sắp xếp trả lại thông tin cho logic chứ đừng rập khuôn (tránh lặp thông tin như ngày, tên,..), ngữ điệu giống con người!. Khi trả lời có thông tin lý do thì hãy thể hiện sự 'có thể', 'không chắc chắn' chứ không nên thể hiện sự chắc chắn, còn không có thông tin lý do thì auto là 'có thể do việc cá nhân', ví dụ: 'Mr. Đỗ Duy Anh đi muộn 1 lần vào ngày 12/5/2025 vì lý do CÓ THỂ LÀ đi cất giấy tờ xe Tucson.' Đừng in đậm câu trả lời, nhớ phải lễ phép. Nếu câu hỏi người dùng không phải là Tiếng Việt, hãy tranfer câu trả lời sang ngôn ngữ của họ rồi mới trả lại câu trả lời nhé. Tránh việc người ta hỏi tiếng Hàn, mà mình trả lời bằng tiếng Việt được. Chị Trương Minh Tâm là nữ nha đừng có nhầm sang nam nữa trời ơi...."

  var result = sendtoGemini(promtp)

  return result
}
*/



function getAnswerFromGemini(question, context) { // (response, companyRules)
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'); // Cấu hình trong Script Properties
  var MODEL_NAME = "gemini-2.5-flash"; // Model ổn định nhất hiện tại

  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL_NAME + ":generateContent?key=" + apiKey;


  var payload = {
    contents: [
      {
        parts: [
          {
            text: `Bạn là trợ lý nhân sự được phát triển bởi công ty ADD Group, chuyên về thiết kế kiến trúc & xây dựng. 
            Dưới đây là nội quy của công ty (từ nhiều file): 
            """${context}"""
            Hãy trả lời câu hỏi của nhân viên một cách chính xác dựa trên nội quy trên và đưa ra lời khuyên (1 câu ngắn) nếu có thể.
            Lưu ý: Hãy trả lời một cách lễ phép bằng chính ngôn ngữ mà câu hỏi được sử dụng (và sử dụng không quá 600 token).
            Câu hỏi: "${question}" `
          }
        ]
      }
    ],
    generationConfig: {
      maxOutputTokens: 600,
      temperature: 0.3
    }
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var json = JSON.parse(response.getContentText());

  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ??
    json?.candidates?.[0]?.content?.parts?.map(p => p?.text).filter(Boolean).join('\n');

  if (typeof text === 'string' && text.trim()) {
    return text.trim();
  } else {
    return "Xin lỗi, tôi không thể tìm thấy câu trả lời trong nội quy.";
  }
}

/*
function bothTypeQuestion(response, name) {
  var result1 = handleMonthlyInformation(response, name)
  var companyRules = getCompanyRules(); // Lấy nội quy từ nhiều file Google Docs

  var promt = 'Kết hợp 2 nguồn thông tin ' + JSON.stringify(result1) + ' và nội quy công ty ' + JSON.stringify(companyRules) + ', để phân tích trả lời cho câu hỏi ' + JSON.stringify(response)

  var finalResult = sendtoGemini(promt)

  return finalResult
}
*/


function testttte() {

  var sheet = SpreadsheetApp.openById('1Up1DFaOAddIEX_ac-ewJb656P8cWrna8uHk3TuipjVE').getSheetByName(SHEET_NAME);
  //lấy danh sách leader + các sếp
  var leaders = getSheetDataRange(sheet, 11, 16, 2, 2)[0]

  console.log(leaders)
}

function loadStaffInfoMap() {
  var map = {};
  try {
    var sheet = null;
    try {
      sheet = SpreadsheetApp.openById(PRIVATE_SPREADSHEET_ID).getSheetByName('StaffInformation');
    } catch (e1) { }
    if (!sheet) {
      try {
        sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StaffInformation');
      } catch (e2) { }
    }
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      for (var r = 1; r < data.length; r++) {
        var realName = String(data[r][1] || '').trim();
        var nickName = String(data[r][2] || '').trim();
        if (nickName && realName) {
          map[nickName.toLowerCase()] = realName;
        }
      }
    }
  } catch (e) {
    Logger.log('Error in loadStaffInfoMap: ' + e.message);
  }
  return map;
}

function getStaffDetailByEmailOrName(email, displayName) {
  try {
    var emailLower = (email || "").toLowerCase().trim();
    var nameLower = (displayName || "").toLowerCase().trim();
    var cacheKey = "STAFF_DETAIL_" + (emailLower || nameLower);

    if (cacheKey) {
      try {
        var cached = CacheService.getScriptCache().get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (ce) { }
    }

    var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StaffInformation');
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();

    var result = null;
    // 1. Ưu tiên khớp chính xác theo Email trước (độ chính xác 100%)
    if (emailLower) {
      for (var r = 1; r < data.length; r++) {
        var rowEmail = String(data[r][11] || "").toLowerCase().trim();
        if (rowEmail === emailLower) {
          result = {
            staffId: String(data[r][0] || "").trim(),
            fullName: String(data[r][1] || "").trim(),
            nickName: String(data[r][2] || "").trim(),
            department: String(data[r][4] || "").trim(),
            division: String(data[r][10] || "").trim(),
            email: rowEmail
          };
          break;
        }
      }
    }

    // 2. Khớp chính xác theo Tên đầy đủ (nếu chưa tìm thấy qua email)
    if (!result && nameLower) {
      for (var r2 = 1; r2 < data.length; r2++) {
        var rowName = String(data[r2][1] || "").toLowerCase().trim();
        if (rowName === nameLower) {
          result = {
            staffId: String(data[r2][0] || "").trim(),
            fullName: String(data[r2][1] || "").trim(),
            nickName: String(data[r2][2] || "").trim(),
            department: String(data[r2][4] || "").trim(),
            division: String(data[r2][10] || "").trim(),
            email: String(data[r2][11] || "").toLowerCase().trim()
          };
          break;
        }
      }
    }

    if (result && cacheKey) {
      try {
        CacheService.getScriptCache().put(cacheKey, JSON.stringify(result), 900); // Lưu cache 15 phút
      } catch (ce) { }
    }

    return result;
  } catch (e) {
    Logger.log("getStaffDetailByEmailOrName error: " + e.toString());
    return null;
  }
}

function getStaffInfoMappingPromptTable() {
  try {
    var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StaffInformation');
    if (!sheet) return "";
    var data = sheet.getDataRange().getValues();
    var lines = ["------------------- Danh sách Ánh xạ Chính xác Tên Nhân Viên & Nick Name (BẮT BUỘC DÙNG ĐỂ ĐỐI CHIẾU MÃ NICK NAME TRONG BẢNG ĐIỂM) -------------------"];
    for (var r = 1; r < data.length; r++) {
      var fullName = String(data[r][1] || "").trim();
      var nickName = String(data[r][2] || "").trim();
      var dept = String(data[r][4] || "").trim();
      var div = String(data[r][10] || "").trim();
      var email = String(data[r][11] || "").trim();
      if (fullName && nickName) {
        lines.push("- Họ và tên: \"" + fullName + "\" ➔ Nick Name trong bảng điểm: \"" + nickName + "\" (Phòng: " + dept + ", Div: " + div + ", Email: " + email + ")");
      }
    }
    return lines.join("\n");
  } catch (e) {
    Logger.log("getStaffInfoMappingPromptTable error: " + e.toString());
    return "";
  }
}

function authorizationUser(user, email) {
  // Helper cục bộ: chuẩn hóa tiếng Việt không dấu (removeAccents không tồn tại ở scope này)
  function removeAccents(str) {
    if (!str) return '';
    return str.normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "d");
  }
  try {
    var sheet = null;
    try {
      sheet = SpreadsheetApp.openById(PRIVATE_SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    } catch (e) {
      Logger.log('Error opening spreadsheet in authorizationUser: ' + e.message);
    }

    if (!sheet) {
      return -1;
    }

    var lastRow7 = getLastRowInColumn(sheet, 7);
    var lastRow8 = getLastRowInColumn(sheet, 8);
    var maxRow = Math.max(lastRow7, lastRow8);

    var standname = getSheetDataRange(sheet, 7, 7, 2, maxRow);
    var position = getSheetDataRange(sheet, 8, 8, 2, maxRow);
    var staff = getSheetDataRange(sheet, 7, 7, 2, maxRow);

    var staff_filtered = [];
    var position_filtered = [];
    var standname_filtered = [];

    for (var k = 0; k < staff.length; k++) {
      if (staff[k] && staff[k][0]) {
        staff_filtered.push(staff[k]);
        position_filtered.push(position[k] || ['']);
        standname_filtered.push(standname[k] || ['']);
      }
    }

    // === PHÂN CẤP QUYỀN HẠN TOÀN HỆ THỐNG 200 AI ===
    // Cấp 1 (God Mode): Sếp Son (Son MinChang / 손민창) - Đánh giá được TẤT CẢ
    // Cấp 2: Sếp Luật (Tô Vũ Luật / 000.Luat) - Đánh giá được TẤT CẢ
    // Cấp 3 (Admin): Duy Anh (Đỗ Duy Anh / 200.Duy Anh) - Đánh giá được TẤT CẢ
    // Hệ thống: 800@add-group.net, boss@add-group.net, ADD IT
    var uLower = removeAccents((user || '').toLowerCase());
    var uRaw = (user || '').toLowerCase();
    var eLower = (email || '').toLowerCase();

    // Helper: kiểm tra xem chuỗi có chứa BẤT KỲ từ khóa nào trong danh sách không
    function matchAny(str, keywords) {
      for (var ki = 0; ki < keywords.length; ki++) {
        if (str.includes(keywords[ki])) return true;
      }
      return false;
    }

    var hasFullAccess = false;

    // Tài khoản hệ thống
    if (matchAny(eLower, ['800@add-group.net', 'boss@add-group.net']) ||
      matchAny(uLower, ['800@add-group.net', 'boss@add-group.net']) ||
      user === 'ADD IT') {
      hasFullAccess = true;
    }

    // Cấp 1: Sếp Son (손민창 / Son, MinChang / Son Min Chang / CEO.Son)
    if (!hasFullAccess) {
      if (uRaw.includes('손민창') || matchAny(uLower, ['minchang', 'ceo.son', 'son min chang']) ||
        matchAny(eLower, ['boss@add-group.net', 'ceo.son'])) {
        hasFullAccess = true;
      }
    }

    // Cấp 1: Sếp Kim (Kim Minjeong / CEO.Kim)
    if (!hasFullAccess) {
      if (matchAny(uLower, ['minjeong', 'kim minjeong', 'ceo.kim']) ||
        matchAny(eLower, ['ceo.kim'])) {
        hasFullAccess = true;
      }
    }

    // Cấp 2: Sếp Luật (Tô Vũ Luật / Luật Tô Vũ / 000.Luat / tvluat@add-group.net)
    if (!hasFullAccess) {
      if (matchAny(uLower, ['000.luat', 'luat', 'tvluat']) ||
        matchAny(eLower, ['000.luat', 'luat', 'tvluat@add-group.net', 'tvluat'])) {
        hasFullAccess = true;
      }
    }

    if (hasFullAccess) {
      return [staff_filtered, position_filtered, standname_filtered];
    }

    // lấy danh sách leader + các sếp từ cả Dòng 1, Dòng 2 và Dòng 3 để tránh lệch dòng cấu hình
    var leadersRow1 = getSheetDataRange(sheet, 9, 16, 1, 1);
    var leadersRow2 = getSheetDataRange(sheet, 9, 16, 2, 2);
    var leadersRow3 = getSheetDataRange(sheet, 9, 16, 3, 3);
    var leaders1 = leadersRow1.length > 0 ? leadersRow1[0] : [];
    var leaders2 = leadersRow2.length > 0 ? leadersRow2[0] : [];
    var leaders3 = leadersRow3.length > 0 ? leadersRow3[0] : [];

    const maxLength = Math.max(leaders1.length, leaders2.length, leaders3.length);

    function isNameMatched(inputStr, targetStr) {
      if (!inputStr || !targetStr) return false;
      var raw1 = String(inputStr).toLowerCase();
      var raw2 = String(targetStr).toLowerCase();

      // Xử lý riêng cho Sếp Son (Son MinChang / 손민창)
      if ((raw1.includes('son') && (raw1.includes('minchang') || raw1.includes('min chang') || raw1.includes('min'))) &&
        (raw2.includes('son') && (raw2.includes('minchang') || raw2.includes('min chang') || raw2.includes('min')))) {
        return true;
      }
      if (raw1.includes('손민창') && raw2.includes('손민창')) return true;

      var s1 = removeAccents(raw1.replace(/[^a-z0-9\u3131-\uD79D\s]/gi, ' ').trim());
      var s2 = removeAccents(raw2.replace(/[^a-z0-9\u3131-\uD79D\s]/gi, ' ').trim());
      if (s1 === s2) return true;

      var w1 = s1.split(/\s+/).filter(Boolean);
      var w2 = s2.split(/\s+/).filter(Boolean);

      if (w1.length > 0 && w2.length > 0) {
        var matchCount1 = 0;
        w1.forEach(function (w) { if (w2.indexOf(w) !== -1) matchCount1++; });
        if (matchCount1 === w1.length && w1.length >= 1) return true;

        var matchCount2 = 0;
        w2.forEach(function (w) { if (w1.indexOf(w) !== -1) matchCount2++; });
        if (matchCount2 === w2.length && w2.length >= 1) return true;
      }
      return false;
    }

    for (var i = 0; i < maxLength; i++) {
      var leaderVal1 = leaders1[i] || '';
      var leaderVal2 = leaders2[i] || '';
      var leaderVal3 = leaders3[i] || '';

      var isMatch =
        isNameMatched(user, leaderVal1) || isNameMatched(user, leaderVal2) || isNameMatched(user, leaderVal3) ||
        isNameMatched(email, leaderVal1) || isNameMatched(email, leaderVal2) || isNameMatched(email, leaderVal3);

      if (isMatch) {
        // Những người có quyền đánh giá TẤT CẢ nhân viên (Cột I, J, K, L -> index 0, 1, 2, 3)
        if (i < 4) {
          return [staff_filtered, position_filtered, standname_filtered]
        }

        var staffl = getSheetDataRange(sheet, i + 9, i + 9, 3, getLastRowInColumn(sheet, i + 9))

        var staffl_filtered = []
        var standnamel = []
        var positionl = []

        for (var j = 0; j < staffl.length; j++) {
          var leaderStaffName = staffl[j][0];
          if (!leaderStaffName) continue;

          for (var k = 0; k < staff_filtered.length; k++) {
            if (staff_filtered[k][0] == leaderStaffName) {
              staffl_filtered.push(staff_filtered[k]);
              standnamel.push(standname_filtered[k]);
              positionl.push(position_filtered[k]);
              break;
            }
          }
        }

        Logger.log([staffl_filtered, positionl, standnamel])

        return [staffl_filtered, positionl, standnamel]
      }
    }
    return -1;
  } catch (error) {
    Logger.log('Error in authorizationUser: ' + error.message);
    return -1;
  }
}

function getUserForOTRegistration() {
  try {
    var sheet = null;
    try {
      sheet = SpreadsheetApp.openById('1ytMbWdEFGrAgyL0xKgp9OzTAOO62Sh7ma1WSOlFK2m4').getSheetByName('Working Time');
    } catch (e) {
      Logger.log('Error opening working time sheet in getUserForOTRegistration: ' + e.message);
    }

    if (!sheet) {
      return [];
    }

    const lastrow = sheet.getLastRow();
    if (lastrow <= 1) return [];

    const staff = sheet.getRange('B2:B' + lastrow).getValues()
    const department = sheet.getRange('I2:I' + lastrow).getValues()
    const company = sheet.getRange('G2:G' + lastrow).getValues()

    var list = []
    for (var i = 0; i < staff.length; i++) {
      if (!staff[i][0]) continue;

      var com = company[i][0] ? company[i][0].split(":") : ['', '']
      var comName = (com[1] != null) ? com[1].trim() : ''
      var departmentStaff = String(department[i][0])
      var email = ''
      var spaceManager = ''

      if (departmentStaff == '200' || departmentStaff == '300') {
        email = 'tvluat@add-group.net'
        spaceManager = 'spaces/6Udkg8AAAAE'
      } else if (departmentStaff == '500') {
        email = 'tmtam@add-group.net'
        spaceManager = 'spaces/_mfTYCAAAAE'
      } else if (departmentStaff == '600') {
        email = 'ntttrang@planadd.com'
        spaceManager = 'spaces/8AoTYCAAAAE'
      }

      // Format cố định 5 parts: NAME | DEPT | EMAIL | SPACE | COMPANY
      list.push({
        text: staff[i][0],
        value: staff[i][0] + " | " + departmentStaff + " | " + email + " | " + spaceManager + " | " + comName,
        bottomText: comName + "-" + departmentStaff,
        selected: false
      })
    }

    return list;
  } catch (error) {
    Logger.log('Error in getUserForOTRegistration: ' + error.message);
    return [];
  }
}


function getUserForSendmessage() {
  try {
    var sheetvpp = null;
    try {
      sheetvpp = SpreadsheetApp.openById('10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ').getSheetByName('List');
    } catch (e) {
      Logger.log('Error opening spreadsheet in getUserForSendmessage: ' + e.message);
    }

    if (!sheetvpp) {
      return [];
    }

    var lastRow = sheetvpp.getLastRow();
    if (lastRow <= 1) return [];

    var valuevpp = sheetvpp.getRange(2, 1, lastRow - 1, 3).getValues();

    var list = []
    for (var i = 0; i < valuevpp.length; i++) {
      list.push({
        text: valuevpp[i][0],
        value: valuevpp[i][2],
        "bottomText": valuevpp[i][1],
        selected: true
      })
    }

    return list;
  } catch (error) {
    Logger.log('Error in getUserForSendmessage: ' + error.message);
    return [];
  }
}

// lấy dữ liệu trong google sheet, 4 tham số, cột bắt đầu, cột kết thúc, hàng bắt đầu và số hàng muốn lấy
function getSheetDataRange(sheet, startCol, endCol, startRow, endRow) {
  if (!sheet) {
    return [];
  }
  if (endRow < startRow) {
    return [];
  }
  try {
    const numCols = endCol - startCol + 1;
    const numRows = endRow - startRow + 1;

    const data = sheet.getRange(startRow, startCol, numRows, numCols).getValues();
    return data;
  } catch (e) {
    Logger.log('Error in getSheetDataRange: ' + e.message);
    return [];
  }
}

function doGet(e) {
  try {
    // Lấy tham số trên URL
    const action = e.parameter.action;

    if (action == "VPApayment") {
      const time = e.parameter.time;
      const project = e.parameter.project;
      const content = e.parameter.content;
      const amount = e.parameter.amount;
      const day = time.split(" ")[0]

      let message = {
        cardsV2: [{
          card: {
            header: {
              title: 'VPA Payment Request',
              imageUrl: 'https://i.postimg.cc/5NtbMt7j/guideline-ADD11-fotor-20251029113238.png'
            },
            sections: [{
              // header: 'Contents',
              widgets: [{
                textParagraph: {
                  text: `- <b>Project</b>: ${project}`
                }
              }, {
                textParagraph: {
                  text: `- <b>Time</b>: ${day}`
                }
              }, {
                textParagraph: {
                  text: `- <b>Content</b>: ${content}`
                }
              }, {
                textParagraph: {
                  text: `- <b>Amount</b>: ${amount}\n`
                }
              }, {
                textParagraph: {
                  text: ''
                }
              }, {
                buttonList: {
                  buttons: [
                    {
                      text: "ACCEPT✅",
                      onClick: {
                        action: {
                          "function": "approveVPA",
                          "parameters": [
                            { key: "action", value: "approveVPA" },
                            { key: "time", value: time },
                            { key: "status", value: 'ok' },
                            { key: "content", value: content },
                            { key: "amount", value: amount }
                          ]
                        }
                      }
                    },
                    {
                      text: "REJECT❌",
                      onClick: {
                        action: {
                          "function": "rejectVPA",
                          "parameters": [
                            { key: "action", value: "rejectVPA" },
                            { key: "time", value: time },
                            { key: "status", value: 'x' },
                            { key: "content", value: content },
                            { key: "amount", value: amount }
                          ]
                        }
                      }
                    }
                  ]
                }
              }
              ]
            },
            ]
          }
        }],
        accessoryWidgets: [{
          buttonList: {
            buttons: [{
              text: 'Opening Google Sheet manually',
              icon: { materialIcon: { name: 'link' } },
              onClick: {
                openLink: {
                  url: 'https://docs.google.com/spreadsheets/d/170amslE4krTtzuEYPrRzjV2bNjXvI9B2z8NPiK0KtQM/edit?gid=2118111282#gid=2118111282'
                }
              }
            }]
          }
        }]
      };
      const messageId = sendMessageByChatBot(message, "spaces/6Udkg8AAAAE")

      const sheetId = "1efrfeVBNcDVuinJ6pgC2-0PQVyz9-LbG_BvCtrMFscM"; // ID Google Sheet
      const ss = SpreadsheetApp.openById(sheetId);
      const sheet = ss.getSheetByName("2025"); // tên sheet lưu dữ liệu

      var targetRow = findTargetRow(sheet, time)

      if (targetRow == 0) {
        return;
      }

      sheet.getRange("Q" + targetRow).setValue(messageId.name)
      sheet.getRange("R" + targetRow).setValue(messageId.createTime)

    } else if (action == "ADDpayment") {
      const time = e.parameter.time;
      const project = e.parameter.project;
      const content = e.parameter.content;
      const amount = e.parameter.amount;
      const day = time.split(" ")[0]
      const staff = e.parameter.staff;

      let message = {
        cardsV2: [{
          card: {
            header: {
              title: 'ADD Payment Request',
              imageUrl: 'https://i.postimg.cc/c4tkYyrN/guideline-ADD3-fotor-20251029113744.png'
            },
            sections: [{
              widgets: [{
                textParagraph: {
                  text: `- <b>Project</b>: ${project}`
                }
              }, {
                textParagraph: {
                  text: `- <b>Staff</b>: ${staff}`
                }
              }, {
                textParagraph: {
                  text: `- <b>Time</b>: ${day}`
                }
              }, {
                textParagraph: {
                  text: `- <b>Content</b>: ${content}`
                }
              }, {
                textParagraph: {
                  text: `- <b>Amount</b>: ${amount}\n`
                }
              }, {
                textParagraph: {
                  text: ''
                }
              }, {
                buttonList: {
                  buttons: [
                    {
                      text: "ACCEPT✅",
                      onClick: {
                        action: {
                          "function": "approveADD",
                          "parameters": [
                            { key: "action", value: "approveADD" },
                            { key: "time", value: time },
                            { key: "status", value: 'ok' },
                            { key: "content", value: content },
                            { key: "amount", value: amount }
                          ]
                        }
                      }
                    },
                    {
                      text: "REJECT❌",
                      onClick: {
                        action: {
                          "function": "rejectADD",
                          "parameters": [
                            { key: "action", value: "rejectADD" },
                            { key: "time", value: time },
                            { key: "status", value: 'x' },
                            { key: "content", value: content },
                            { key: "amount", value: amount }
                          ]
                        }
                      }
                    }
                  ]
                }
              }
              ]
            },
            ]
          }
        }],
        accessoryWidgets: [{
          buttonList: {
            buttons: [{
              text: 'Open Google Sheet for details',
              icon: { materialIcon: { name: 'link' } },
              onClick: {
                openLink: {
                  url: 'https://docs.google.com/spreadsheets/d/1T6utwc9Jaldi6iSLytS9Z2p2tNqaAkrWSaMzYegInzI/edit?gid=710734631#gid=710734631'
                }
              }
            }]
          }
        }]
      };
      const messageId = sendMessageByChatBot(message, "spaces/6Udkg8AAAAE")

      const sheetId = "1T6utwc9Jaldi6iSLytS9Z2p2tNqaAkrWSaMzYegInzI";
      const ss = SpreadsheetApp.openById(sheetId);
      const sheet = ss.getSheetByName("Form Responses 1");

      var targetRow = findTargetRow(sheet, time)

      if (targetRow == 0) {
        return;
      }

      sheet.getRange("Q" + targetRow).setValue(messageId.name)
      sheet.getRange("R" + targetRow).setValue(messageId.createTime)

    } else if (action == "VPAReminder" || action == "ADDReminder") {

      const sheetId = "1efrfeVBNcDVuinJ6pgC2-0PQVyz9-LbG_BvCtrMFscM"; // ID Google Sheet
      const ss = SpreadsheetApp.openById(sheetId);
      const sheet = ss.getSheetByName("2025"); // tên sheet lưu dữ liệu

      const lastrow = sheet.getLastRow()

      const contentCol = sheet.getRange(3, 7, lastrow - 2, 1).getDisplayValues().flat(); // G
      const amountCol = sheet.getRange(3, 8, lastrow - 2, 1).getDisplayValues().flat(); // H
      const statusCol = sheet.getRange(3, 9, lastrow - 2, 1).getDisplayValues().flat(); // I
      const nameMsgCol = sheet.getRange(3, 17, lastrow - 2, 1).getDisplayValues().flat(); // Q
      const createTimeCol = sheet.getRange(3, 18, lastrow - 2, 1).getDisplayValues().flat(); // R

      const data = {}
      for (var i = 0; i < statusCol.length; i++) {
        if (!safeTrim(statusCol[i])) {
          if (safeTrim(nameMsgCol[i]) && safeTrim(createTimeCol[i])) {
            let key = contentCol[i] + " - " + amountCol[i]
            let value = nameMsgCol[i] + " | " + createTimeCol[i]
            data[key] = value
          }
        }
      }

      const count = Object.keys(data).length

      if (count <= 0) {
        return;
      }

      const firm = action == "VPAReminder" ? "VPA" : "ADD"
      sendMessageByChatBot({ text: `Boss still has ${count} *${firm}* payment requests to consider! Detail ▼` }, "spaces/6Udkg8AAAAE")

      for (let key in data) {
        if (data.hasOwnProperty(key)) {
          const inforMsg = data[key].split("|")

          var text = "*Pending Approval* \n" +
            `Content: ${key}`

          createMessageQuoteMessage(text, safeTrim(inforMsg[0]), safeTrim(inforMsg[1]), "spaces/6Udkg8AAAAE")
        }
      }
    }
  } catch (err) {
    Logger.log(err.message)
  }
}

function tototototttoooooooooooooo() {
  const action = "VPAReminder"

  const sheetId = "1efrfeVBNcDVuinJ6pgC2-0PQVyz9-LbG_BvCtrMFscM"; // ID Google Sheet
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName("2025"); // tên sheet lưu dữ liệu

  const lastrow = sheet.getLastRow()

  const contentCol = sheet.getRange(3, 7, lastrow - 2, 1).getDisplayValues().flat(); // G
  const amountCol = sheet.getRange(3, 8, lastrow - 2, 1).getDisplayValues().flat(); // H
  const statusCol = sheet.getRange(3, 9, lastrow - 2, 1).getDisplayValues().flat(); // I
  const nameMsgCol = sheet.getRange(3, 17, lastrow - 2, 1).getDisplayValues().flat(); // Q
  const createTimeCol = sheet.getRange(3, 18, lastrow - 2, 1).getDisplayValues().flat(); // R

  const data = {}
  for (var i = 0; i < statusCol.length; i++) {
    if (!safeTrim(statusCol[i])) {
      if (safeTrim(nameMsgCol[i]) && safeTrim(createTimeCol[i])) {
        let key = contentCol[i] + " - " + amountCol[i]
        let value = nameMsgCol[i] + " | " + createTimeCol[i]
        data[key] = value
      }
    }
  }

  const count = Object.keys(data).length

  if (count <= 0) {
    return;
  }

  const firm = action == "VPAReminder" ? "VPA" : "ADD"
  sendMessageByChatBot({ text: `Boss still has ${count} *${firm}* payment requests to consider! Detail ▼` }, "spaces/6Udkg8AAAAE")

  for (let key in data) {
    if (data.hasOwnProperty(key)) {
      const inforMsg = data[key].split("|")

      var text = "*Pending Approval* \n" +
        `Content: ${key}`

      createMessageQuoteMessage(text, safeTrim(inforMsg[0]), safeTrim(inforMsg[1]), "spaces/6Udkg8AAAAE")
    }
  }
}


function createMessageQuoteMessage(text, name, createTime, parent) {
  try {
    const service = getService_();
    if (!service.hasAccess()) {
      return;
    }

    const message = {
      text,
      quotedMessageMetadata: {
        name,
        lastUpdateTime: createTime
      }
    };

    const response = Chat.Spaces.Messages.create(
      message,
      parent,
      {},
      { 'Authorization': 'Bearer ' + service.getAccessToken() });

    return response
  } catch (err) {
    Logger.log('Failed to create message with error %s', err.message);
  }

}

function doPost(e) {
  const event = JSON.parse(e.postData.contents);
  if (event.type === 'CARD_CLICKED') {
    return onCardClick(event);
  }
}

// Hàm xử lý sự kiện khi người dùng click nút (Google Chat sẽ gọi hàm này)
function onCardClick(event) {
  if (!event || !event.action || !event.action.parameters) {
    Logger.log('BUILD_ID=' + BUILD_ID);
    Logger.log('onCardClick missing action/parameters: ' + JSON.stringify({
      type: event?.type,
      hasAction: !!event?.action,
      actionKeys: event?.action ? Object.keys(event.action) : null,
      commonParameters: event?.common?.parameters,
    }));
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INVALID_ARGUMENT',
            userFacingMessage: 'Sự kiện không hợp lệ (thiếu action.parameters). Vui lòng thử lại.'
          }
        }
      }
    };
  }

  const parameters = event.action.parameters || [];
  let paramsCardV2 = {};
  parameters.forEach(param => {
    paramsCardV2[param.key] = param.value;
  });
  const action = paramsCardV2.action || event.common?.parameters?.action;

  if (action == 'submitDialog') return submitDialog(event);
  if (action == 'submitDialogVPP') return submitDialogVPP(event);
  if (action == 'submitSendmessage') return submitSendmessage(event);
  if (action == 'submitOvertime') return submitOvertime(event);
  if (action == 'submitDocDelivery') return submitDocDelivery(event);
  if (action == 'submitStampDocument') return submitStampDocument(event);
  if (action == 'onNameInputChange') return onNameInputChange(event);


  if (action == 'approveOvertime' || action == 'rejectOvertime') {
    handleOvertime(paramsCardV2)
  }

  if (action == 'approveStampReturn' || action == 'rejectStampReturn') {
    handleStampReturn(paramsCardV2, event)
  }
}

function findTargetRow(sheet, day) {
  const lastRow = sheet.getLastRow(); // số dòng có dữ liệu
  const colA = sheet.getRange(1, 1, lastRow).getDisplayValues();

  for (var i = 0; i < colA.length; i++) {
    if (day == colA[i][0]) {
      return i + 1
    }
  }

  return 0
}

function hohohoho() {

}

function updateMessage(newMessage, updateMask, name) {
  Chat.Spaces.Messages.patch(newMessage, name, {
    updateMask: updateMask
  });
}

function updateMessageByBot(newMessage, updateMask, name) {
  try {
    const service = getService_();
    if (!service.hasAccess()) {
      return;
    }

    const response = Chat.Spaces.Messages.patch(newMessage, name, {
      updateMask: updateMask
    },
      { 'Authorization': 'Bearer ' + service.getAccessToken() });

    return response.lastUpdateTime
  } catch (err) { }
}

function teetetetete() {
  const newMessage = {
    cardsV2: [{
      card: {
        header: {
          title: "VPA Payment Request",
          subtitle: "✅ ACCEPTED at " + getFormattedDate(),
          imageUrl: "",
        },
        sections: [{
          widgets: [{
            textParagraph: {
              text: `- <b>Content</b>: klahsdfkhaskdhfaskjfh`
            }
          }, {
            textParagraph: {
              text: `- <b>Amount</b>: 100000\n`
            }
          }, {
            textParagraph: {
              text: ''
            }
          }
          ]
        },
        ]
      }
    }]
  };

  const res = updateMessageByBot(newMessage, "cardsV2", "spaces/6Udkg8AAAAE/messages/ip2qc8Rux54.ip2qc8Rux54")

  console.log(res)
}

function getFormattedDate() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();

  return `${hours}:${minutes} ${day}/${month}/${year}`;
}

function handleOvertime(params) {
  const sheetId = "1V6KdebLwMcL7TEaF-UmSGtAB_JBExRP_yw6MA8HOSmU"; // ID Google Sheet
  const ss = SpreadsheetApp.openById(sheetId);
  const currentYear = new Date().getFullYear().toString();
  const sheet = ss.getSheetByName(currentYear) || ss.getSheetByName("2026"); // tên sheet lưu dữ liệu

  let result = 'ok'
  let respond = 'Phê Duyệt'
  let icon = '✅'

  if (params.action == 'rejectOvertime') {
    result = 'Không duyệt'
    respond = 'Không Phê Duyệt'
    icon = '❌'
  }


  const currentResult = sheet.getRange("L" + params.index).getValue()
  const currentResultTrim = safeTrim(currentResult)
  if (currentResultTrim == result) {
    let mess = `Phản hồi thành công đề nghị tăng ca của *${params.staff}*!\n` +
      ` - *Thời gian*: ${params.rangetime} \n` +
      ` - *Trạng thái*: ${respond} ${icon}`

    sendMessageByChatBot({ text: mess }, params.spaceleader)
  } else if (currentResultTrim != result && currentResultTrim != '') {

    let mess = `*Thay đổi* quyết định về đề nghị tăng ca của *${params.staff}* thành công!\n` +
      ` - *Thời gian*: ${params.rangetime} \n` +
      ` - *Trạng thái*: ${respond} ${icon}`

    sendMessageByChatBot({ text: mess }, params.spaceleader)

    sheet.getRange("L" + params.index).setValue(result)

    const messageRespond = `Cấp trên đã *thay đổi* quyết định về đề nghị tăng ca của anh/chị: *${respond}* ${icon} \n\n` +
      `Cụ thể: \n` +
      `  - *Rangetime*: ${params.rangetime}\n` +
      `  - *Project*: ${params.project}\n` +
      `  - *Work*: ${params.work}\n`

    sendMessageByChatBot({ text: messageRespond }, params.space)
  } else {

    sheet.getRange("L" + params.index).setValue(result)

    const messFinal = `Phản hồi thành công đề nghị tăng ca của *${params.staff}*!\n` +
      ` - *Thời gian*: ${params.rangetime} \n` +
      ` - *Trạng thái*: ${respond} ${icon}`

    sendMessageByChatBot({ text: messFinal }, params.spaceleader)

    const messageRespond = `Cấp trên đã *${respond}* đề nghị tăng ca của anh/chị ${icon} \n\n` +
      `Cụ thể: \n` +
      `  - *Rangetime*: ${params.rangetime}\n` +
      `  - *Project*: ${params.project}\n` +
      `  - *Work*: ${params.work}\n`

    sendMessageByChatBot({ text: messageRespond }, params.space)
  }
}

// ── Xử lý phê duyệt trả dấu (Stamp Return Approval) ────────────────────────
function handleStampReturn(params, event) {
  try {
    var ss = SpreadsheetApp.openById(STAMP_DOC_SPREADSHEET_ID);
    var currentYear = new Date().getFullYear().toString();
    var sheet = ss.getSheetByName(currentYear) || ss.getSheetByName('2026') || ss.getSheets()[0];

    if (!sheet) {
      Logger.log('handleStampReturn: Không tìm thấy sheet!');
      return;
    }

    var rowIndex = parseInt(params.row, 10);
    if (!rowIndex || rowIndex < 2) {
      Logger.log('handleStampReturn: rowIndex không hợp lệ: ' + params.row);
      return;
    }

    var isApprove = (params.action === 'approveStampReturn');
    var statusValue = isApprove ? 'Đã trả' : 'Chưa trả';
    var icon = isApprove ? '✅' : '❌';
    var statusLabel = isApprove ? 'STAMP RETURNED' : 'STAMP NOT RETURNED';

    // Kiểm tra trạng thái hiện tại
    var currentStatus = safeTrim(sheet.getRange('A' + rowIndex).getValue());

    // Ghi giá trị vào Cột A (Trạng thái)
    sheet.getRange('A' + rowIndex).setValue(statusValue);

    // Lấy thông tin người nhấn nút (người xác nhận trả dấu)
    var approverName = (event && event.user && (event.user.displayName || event.user.email)) ? (event.user.displayName || event.user.email) : 'N/A';

    // Cập nhật thẻ Card gốc trong phòng 200.notification (hiển thị rõ người nhấn accept, cập nhật trực tiếp tại thẻ)
    var messageName = (event && event.message && event.message.name) ? event.message.name : (params.messageName || '');
    if (messageName) {
      var updatedCard = {
        cardsV2: [{
          card: {
            header: {
              title: icon + ' ' + statusLabel,
              imageUrl: 'https://thumbs.dreamstime.com/b/valid-red-stamp-white-background-437756946.jpg'
            },
            sections: [{
              widgets: [
                { textParagraph: { text: '- <b>Người đăng ký</b>: ' + (params.staff || 'N/A') } },
                { textParagraph: { text: '- <b>Dự án</b>: ' + (params.projectName || '') } },
                { textParagraph: { text: '- <b>Tên tài liệu</b>: ' + (params.docName || '') } },
                { textParagraph: { text: '- <b>Loại dấu</b>:<br>' + (params.stampType || '(chưa chọn)').split(', ').map(function (s) { return '&nbsp;&nbsp;• ' + s; }).join('<br>') } },
                { buttonList: { buttons: [{ text: '📊 Xem Google Sheet', onClick: { openLink: { url: 'https://docs.google.com/spreadsheets/d/1jmiNyx69vxJE4xhJV8t5y2L5jrLwVZhZ2TswDSQX6Wg/edit?gid=293307919#gid=293307919' } } }] } },
                { textParagraph: { text: '\n' + icon + ' <b>Trạng thái</b>: ' + statusValue + ' — ' + getFormattedDate() } },
                { textParagraph: { text: '👤 <b>Xác nhận bởi</b>: <b>' + approverName + '</b>' } }
              ]
            }]
          }
        }]
      };
      updateMessageByBot(updatedCard, 'cardsV2', safeTrim(messageName));
    }

    Logger.log('handleStampReturn: Cập nhật Cột A row ' + rowIndex + ' = "' + statusValue + '"');

  } catch (error) {
    Logger.log('handleStampReturn error: ' + error.message + ' | stack: ' + error.stack);
  }
}

// Hàm xử lý khi submit dialog
function submitDialog(event) {

  var sheet = SpreadsheetApp.openById(PRIVATE_SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  try {
    const formInputs = event.common?.formInputs || {};

    let point = getValue(formInputs.pointInput);
    let reason = getValue(formInputs.reasonInput) || " ";

    const employeesInput = formInputs['employeesInput'];

    if (!employeesInput && !employeesInput[''].stringInputs && !employeesInput[''].stringInputs.value) {
      return
    }

    const selectedEmployees = employeesInput[''].stringInputs.value;
    if (!selectedEmployees || !point || !reason) {
      return
    }


    const timestamp = new Date();
    const user = event.user.displayName || event.user.email || 'Unknown User';

    const pointValue = parseInt(point);

    // Đọc tổng điểm hiện tại TRƯỚC KHI ghi để tính tổng chính xác
    var scoreMap = getEmployeeTotalScores(true);

    var lastRow = getLastRowInColumn(sheet, 1) + 1
    for (var i = 0; i < selectedEmployees.length; i++) {
      sheet.insertRowAfter(lastRow - 1);
      sheet.getRange(lastRow, 1, 1, 5).setValues([[user, timestamp, selectedEmployees[i], reason, pointValue]]);
      lastRow++
    }

    const space = event.space?.name;

    // sendMessageToSpace(selectedEmployees, point, reason, space)

    let mess = ""
    const pointAbs = Math.abs(parseInt(point));
    let pointDisplay = "";
    let sign = " + ";
    if (parseInt(point) > 0) {
      sign = " + ";
      pointDisplay = pointAbs + " ❤️";
    } else if (parseInt(point) < 0) {
      sign = " - ";
      pointDisplay = pointAbs + " 💣";
    }

    let displayReason = "";
    if (reason && reason.trim() !== "") {
      displayReason = ". *Reason:* " + reason;
    }

    Logger.log("1")
    // Tính tổng điểm mới = điểm cũ + điểm vừa chấm
    var totalLine = formatTotalLine(selectedEmployees, scoreMap, pointValue);

    mess = "*" + standForName(selectedEmployees) + "*" + sign + "*" + pointDisplay + "*" + displayReason + "." + totalLine
    Logger.log("*")

    sendMessageByChatBot({ text: mess }, space);

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'OK',
            userFacingMessage: 'Đã thành công!'
          }
        }
      }
    };

  } catch (error) {

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INTERNAL',
            userFacingMessage: 'Có lỗi xảy ra: ' + error.message
          }
        }
      }
    };
  }
}

function getCurrentFormattedDate() {
  var now = new Date();

  var hours = String(now.getHours()).padStart(2, '0');
  var minutes = String(now.getMinutes()).padStart(2, '0');
  var day = String(now.getDate()).padStart(2, '0');
  var month = String(now.getMonth() + 1).padStart(2, '0'); // Tháng bắt đầu từ 0
  var year = now.getFullYear();

  return `${hours}:${minutes} ${day}/${month}/${year}`;
}

function sendMessageToDM(message, space) {
  const service = getOAuthService();
  const url = `https://chat.googleapis.com/v1/${space}/messages`;

  const payload = {
    text: message
  };

  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      Authorization: 'Bearer ' + service.getAccessToken()
    },
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

function submitDialogVPP(event) {
  try {
    // ✅ Khởi tạo trong try-catch để tránh crash ngoài scope
    var sheet1 = SpreadsheetApp.openById('10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ').getSheetByName('2026'); // ← đổi tên sheet nếu sai

    // ✅ Null guard: getSheetByName trả null nếu tên sheet không tồn tại
    if (!sheet1) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'NOT_FOUND',
              userFacingMessage: 'Không tìm thấy sheet! Kiểm tra lại tên sheet.'
            }
          }
        }
      };
    }

    const formInputs = event.common?.formInputs || {};

    const vpp = getValue(formInputs.vppInput);
    const quantity = getValue(formInputs.quantityInput);
    const link = getValue(formInputs.linkInput);

    const space = event.space?.name;

    if (!isNumber(quantity)) {
      var errorMsg = "*Đăng kí không thành công*⚠️\nLỗi: Sai định dạng số (Số lượng)"
      sendMessageToDM(errorMsg, space)
      return;
    }

    const user = event.user.displayName || event.user.email || 'Unknown User';

    sheet1.insertRows(3, 1);

    const timestamp = getCurrentFormattedDate();
    sheet1.getRange("A3").setValue(timestamp);
    sheet1.getRange("B3").setValue(user);
    sheet1.getRange("C3").setValue(vpp);
    sheet1.getRange("D3").setValue(quantity);
    sheet1.getRange("F3").setValue(link);

    var vppSheetUrl = "https://docs.google.com/spreadsheets/d/10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ/edit?gid=617945518#gid=617945518";

    // ── Gửi Card thông báo trực tiếp từ 200AI với định dạng đẹp (CardsV2) thay cho Email ──
    var notifyWidgets = [
      { textParagraph: { text: '- <b>Người đăng ký</b>: ' + user } },
      { textParagraph: { text: '- <b>Văn phòng phẩm</b>: ' + vpp } },
      { textParagraph: { text: '- <b>Số lượng</b>: ' + quantity } }
    ];
    if (link && link.trim() !== '') {
      notifyWidgets.push({ textParagraph: { text: '- <b>Link sản phẩm</b>: ' + link } });
    }
    notifyWidgets.push({
      buttonList: {
        buttons: [{
          text: '📊 Xem Google Sheet',
          onClick: { openLink: { url: vppSheetUrl } }
        }]
      }
    });

    var notifyMsg = {
      cardsV2: [{
        card: {
          header: {
            title: '🧷 OFFICE SUPPLIES',
            subtitle: '⏳ ' + timestamp,
            imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/edit_note/default/24px.svg'
          },
          sections: [{
            widgets: notifyWidgets
          }],
          fixedFooter: {
            primaryButton: {
              text: 'Xem Google Sheet',
              onClick: {
                openLink: {
                  url: vppSheetUrl
                }
              }
            }
          }
        }
      }]
    };

    // 1. Gửi Card V2 định dạng đẹp vào khung chat của người dùng khi đăng ký thành công
    if (space && space !== 'spaces/AAQA2_sKqYQ') {
      sendMessageByChatBot(notifyMsg, space);
    }

    // 2. Gửi Card V2 định dạng đẹp tới nhóm 200.Notification (spaces/AAQA2_sKqYQ)
    sendMessageByChatBot(notifyMsg, 'spaces/AAQA2_sKqYQ');

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'OK',
            userFacingMessage: 'Đã thành công!'
          }
        }
      }
    };

  } catch (error) {
    // ✅ Catch không dùng sheet1 nữa → tránh crash kép khi sheet1 là null
    Logger.log('submitDialogVPP error: ' + error.message);
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INTERNAL',
            userFacingMessage: 'Có lỗi xảy ra: ' + error.message
          }
        }
      }
    };
  }
}

function isNumber(value) {
  return !isNaN(value) && typeof value !== 'boolean' && value !== '';
}

function test1() {
  var message = "📦 Tháng mới, ADD tiến hành cấp phát văn phòng phẩm.|Anh/chị/em có nhu cầu vui lòng đăng ký với phòng 200 để được hỗ trợ kịp thời. Rất mong mọi người chủ động để tránh thiếu sót.|Cách đặt văn phòng phẩm như sau:|Bước 1: Truy cập vào chatbox với *200AI*|Bước 2: Gõ */OfficeSupply*|Bước 3: Đăng ký văn phòng phẩm mà mình đang thiếu"
  var temp = message.split('|')
  message = temp.join('\n')

  finalMessage = "*_THÔNG BÁO ĐẶT VĂN PHÒNG PHẨM_*\n" + message

  Chat.Spaces.Messages.create({ text: finalMessage }, 'spaces/sx4DQsAAAAE', {});
}


function submitSendmessage(event) {
  try {
    const formInputs = event.common?.formInputs || {};
    var message = getValue(formInputs.message);
    const title = getValue(formInputs.title);
    const employeesInput = formInputs['employeesInput'];

    if (!employeesInput && !employeesInput[''].stringInputs && !employeesInput[''].stringInputs.value) {
      return
    }

    const selectedEmployees = employeesInput[''].stringInputs.value;
    if (!selectedEmployees || !message) {
      return
    }

    var temp = message.split('|')
    message = temp.join('\n')

    message = message.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (match, text, url) {
      return '<' + url + '|' + text + '>';
    });

    var finalMessage = "*_" + "[ĐÂY LÀ THÔNG BÁO TỰ ĐỘNG CỦA PHÒNG 200]" + "_*\n" + title.toUpperCase() + message


    for (var i = 0; i < selectedEmployees.length; i++) {
      Chat.Spaces.Messages.create({ text: finalMessage }, selectedEmployees[i], {});
    }

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'OK',
            userFacingMessage: 'Đã thành công!'
          }
        }
      }
    };

  } catch (error) {
    sendMessageToDM(error.message, 'spaces/sx4DQsAAAAE')
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INTERNAL',
            userFacingMessage: 'Có lỗi xảy ra: ' + error.message
          }
        }
      }
    };
  }
}

function submitOvertime(event) {
  try {
    const ss = SpreadsheetApp.openById('1V6KdebLwMcL7TEaF-UmSGtAB_JBExRP_yw6MA8HOSmU');
    const currentYear = new Date().getFullYear().toString();
    var sheet1 = ss.getSheetByName(currentYear) || ss.getSheetByName('2026');

    if (!sheet1) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'NOT_FOUND',
              userFacingMessage: 'Không tìm thấy sheet OT!'
            }
          }
        }
      };
    }
    var lastRow = sheet1.getLastRow() + 1;

    const formInputs = event.common?.formInputs || {};

    const staffInput = formInputs['staff'];
    const project = getValue(formInputs.project);
    const content = getValue(formInputs.content);

    if (!staffInput || !staffInput[''] || !staffInput[''].stringInputs) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'INVALID_ARGUMENT',
              userFacingMessage: 'Vui lòng chọn nhân viên!'
            }
          }
        }
      };
    }

    const startMs = convertMsToDateTime(formInputs.startDate[""].dateTimeInput.msSinceEpoch);
    const endMs = convertMsToDateTime(formInputs.endDate[""].dateTimeInput.msSinceEpoch);
    const selectedEmployee = staffInput[''].stringInputs.value;

    const data = selectedEmployee[0].split("|");
    // Null guard: dùng || '' để tránh undefined.trim() crash
    const employee = (data[0] || '').trim();
    const department = (data[1] || '').trim();
    const email = (data[2] || '').trim();
    const spaceManager = (data[3] || '').trim();
    const company = (data[4] || '').trim();

    const space = event.space?.name;

    if (!employee || !project || !content || !department || !company || !startMs || !endMs) {
      Logger.log('submitOvertime missing fields: ' + JSON.stringify({ employee, project, content, department, company }));
      Chat.Spaces.Messages.create({ text: "*Đăng kí không thành công*⚠️ Thiếu thông tin!" }, space, {});
      return;
    }

    Logger.log('submitOvertime started for: ' + employee);

    const ss2 = startMs.split(" ");
    const se = endMs.split(" ");

    sheet1.getRange("A" + lastRow).setValue(getNowFormatted());
    sheet1.getRange("C" + lastRow).setValue(employee);
    sheet1.getRange("D" + lastRow).setValue(ss2[0]);
    sheet1.getRange("E" + lastRow).setValue(getDayOfWeek(ss2[0]));
    sheet1.getRange("F" + lastRow).setValue(String(ss2[1]) + " " + String(ss2[2]));
    sheet1.getRange("G" + lastRow).setValue(String(se[1]) + " " + String(se[2]));
    sheet1.getRange("H" + lastRow).setValue(department);
    sheet1.getRange("H" + lastRow).setHorizontalAlignment("right");
    sheet1.getRange("I" + lastRow).setValue(project);
    sheet1.getRange("J" + lastRow).setValue(content);
    sheet1.getRange("K" + lastRow).setValue(company);

    var mess = "Bạn đã đăng ký Overtime thành công ✅ <https://docs.google.com/spreadsheets/d/1V6KdebLwMcL7TEaF-UmSGtAB_JBExRP_yw6MA8HOSmU/edit?gid=1995509897#gid=1995509897|Xem chi tiết>";
    sendMessageByChatBot({ text: mess }, space);

    const message = {
      cardsV2: [{
        card: {
          header: {
            title: 'OVERTIME REGISTRATION',
            imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/info/default/24px.svg'
          },
          sections: [{
            widgets: [{
              textParagraph: { text: `- <b>Staff</b>: ${employee}` }
            }, {
              textParagraph: {
                text: `- <b>Rangetime</b>: ${String(ss2[1]) + " " + String(ss2[2])} - ${String(se[1]) + " " + String(se[2])} (${convertToDDMMYYYY(ss2[0])})`
              }
            }, {
              textParagraph: { text: `- <b>Project</b>: ${project}` }
            }, {
              textParagraph: { text: `- <b>Work</b>: ${content}\n` }
            }, {
              buttonList: {
                buttons: [
                  {
                    text: "ACCEPT✅",
                    onClick: {
                      action: {
                        "function": "approveOvertime",
                        "parameters": [
                          { key: "action", value: "approveOvertime" },
                          { key: "staff", value: employee },
                          { key: "rangetime", value: `${String(ss2[1]) + " " + String(ss2[2])} - ${String(se[1]) + " " + String(se[2])} (${convertToDDMMYYYY(ss2[0])})` },
                          { key: "project", value: String(project) },
                          { key: "work", value: String(content) },
                          { key: "index", value: String(lastRow) },
                          { key: "space", value: String(space) },
                          { key: "spaceleader", value: String(spaceManager) }
                        ]
                      }
                    }
                  },
                  {
                    text: "REJECT❌",
                    onClick: {
                      action: {
                        "function": "rejectOvertime",
                        "parameters": [
                          { key: "action", value: "rejectOvertime" },
                          { key: "staff", value: employee },
                          { key: "rangetime", value: `${String(ss2[1]) + " " + String(ss2[2])} - ${String(se[1]) + " " + String(se[2])} (${convertToDDMMYYYY(ss2[0])})` },
                          { key: "project", value: String(project) },
                          { key: "work", value: String(content) },
                          { key: "index", value: String(lastRow) },
                          { key: "space", value: String(space) },
                          { key: "spaceleader", value: String(spaceManager) }
                        ]
                      }
                    }
                  }
                ]
              }
            }]
          }]
        }
      }],
      accessoryWidgets: [{
        buttonList: {
          buttons: [{
            text: 'Open Google Sheet for details',
            icon: { materialIcon: { name: 'link' } },
            onClick: { openLink: { url: 'https://docs.google.com/spreadsheets/d/1V6KdebLwMcL7TEaF-UmSGtAB_JBExRP_yw6MA8HOSmU/edit?gid=1995509897#gid=1995509897' } }
          }]
        }
      }]
    };

    if (spaceManager) {
      sendMessageByChatBot(message, spaceManager);
    }

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'OK',
            userFacingMessage: 'Đăng ký OT thành công!'
          }
        }
      }
    };

  } catch (error) {
    Logger.log('submitOvertime error: ' + error.message);
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INTERNAL',
            userFacingMessage: 'Có lỗi xảy ra: ' + error.message
          }
        }
      }
    };
  }
}

function loadRecipientHistory() {
  try {
    var cache = CacheService.getScriptCache();
    var cachedData = cache.get("RECIPIENT_HISTORY_CACHE");
    if (cachedData) {
      try {
        return JSON.parse(cachedData);
      } catch (eCache) {
        Logger.log('Cache parse error: ' + eCache.message);
      }
    }

    var ss = SpreadsheetApp.openById(DOC_DELIVERY_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(DOC_DELIVERY_SHEET_NAME) || ss.getSheetByName('2026');

    var recipientMap = {};

    if (sheet) {
      var lastRow = sheet.getLastRow();
      if (lastRow > 2) {
        var data = sheet.getRange(3, 3, lastRow - 2, 3).getValues();
        for (var i = 0; i < data.length; i++) {
          var rName = safeTrim(data[i][0]);
          var rPhone = safeTrim(data[i][1]);
          var rAddr = safeTrim(data[i][2]);
          if (rName) {
            // Khóa phân biệt kết hợp cả Tên + SĐT + Địa chỉ
            var comboKey = rName + '|' + rPhone + '|' + rAddr;
            if (!recipientMap[comboKey]) {
              recipientMap[comboKey] = { name: rName, phone: rPhone, address: rAddr };
            }
          }
        }
      }
    }

    var list = [
      { text: '📋 -- Chọn người nhận từ danh sách lịch sử --', value: '', selected: true }
    ];

    for (var key in recipientMap) {
      if (recipientMap.hasOwnProperty(key)) {
        var rec = recipientMap[key];
        var valStr = rec.name + '|' + (rec.phone || '') + '|' + (rec.address || '');
        var displayText = rec.name +
          (rec.phone ? ' — ' + rec.phone : '') +
          (rec.address ? ' — ' + rec.address : '');
        list.push({
          text: displayText,
          value: valStr,
          selected: false
        });
      }
    }

    // Cache danh sách trong RAM 10 phút (600 giây) giúp gợi ý phản hồi cực nhanh (~10ms)
    try {
      cache.put("RECIPIENT_HISTORY_CACHE", JSON.stringify(list), 600);
    } catch (ePut) {
      Logger.log('Cache put error: ' + ePut.message);
    }

    return list;
  } catch (error) {
    Logger.log('Error in loadRecipientHistory: ' + error.message);
    return [{ text: '📋 -- Chọn người nhận từ danh sách lịch sử --', value: '', selected: true }];
  }
}

function onWidgetUpdate(event) {
  var parameters = (event && event.action && event.action.parameters) || [];
  var paramsMap = {};
  parameters.forEach(function (param) {
    paramsMap[param.key] = param.value;
  });
  var action = paramsMap.action || '';

  if (action === 'onNameAutoComplete') {
    return onNameAutoComplete(event);
  }

  // Fallback
  return {
    actionResponse: {
      type: 'UPDATE_WIDGET',
      updatedWidget: {
        suggestions: { items: [] }
      }
    }
  };
}

function onNameAutoComplete(event) {
  try {
    // Lấy text user đang gõ từ autocomplete_widget_query
    var typedText = '';
    try {
      typedText = (event.common.parameters['autocomplete_widget_query'] || '').toLowerCase();
    } catch (e) {
      try {
        typedText = (event.common.formInputs.nameInput.stringInputs.value[0] || '').toLowerCase();
      } catch (e2) {
        typedText = '';
      }
    }

    var recipientList = loadRecipientHistory();
    var filteredItems = [];

    for (var i = 0; i < recipientList.length; i++) {
      var item = recipientList[i];
      if (item.value && item.text.toLowerCase().indexOf(typedText) !== -1) {
        filteredItems.push({ text: item.text });
      }
    }

    // Nếu không gõ gì → trả về toàn bộ danh sách
    if (filteredItems.length === 0) {
      for (var j = 0; j < recipientList.length; j++) {
        if (recipientList[j].value) {
          filteredItems.push({ text: recipientList[j].text });
        }
      }
    }

    Logger.log('onNameAutoComplete: typedText="' + typedText + '", results=' + filteredItems.length);

    return {
      actionResponse: {
        type: 'UPDATE_WIDGET',
        updatedWidget: {
          suggestions: {
            items: filteredItems
          }
        }
      }
    };
  } catch (error) {
    Logger.log('Error in onNameAutoComplete: ' + error.message);
    return {
      actionResponse: {
        type: 'UPDATE_WIDGET',
        updatedWidget: {
          suggestions: {
            items: []
          }
        }
      }
    };
  }
}

function onNameInputChange(event) {
  try {
    var formInputs = (event.common && event.common.formInputs) || {};
    var nameRaw = getValue(formInputs.nameInput) || '';
    var phone = getValue(formInputs.phoneInput) || '';
    var address = getValue(formInputs.addressInput) || '';
    var method = getValue(formInputs.deliveryMethod) || '';
    var note = getValue(formInputs.noteInput) || '';

    var finalName = safeTrim(nameRaw);
    var finalPhone = safeTrim(phone);
    var finalAddress = safeTrim(address);

    // Parse "Tên — SĐT — Địa chỉ" format từ suggestion
    if (finalName && finalName.indexOf(' \u2014 ') !== -1) {
      var parts = finalName.split(' \u2014 ');
      finalName = safeTrim(parts[0] || '');
      if (!finalPhone && parts[1]) finalPhone = safeTrim(parts[1]);
      if (!finalAddress && parts[2]) finalAddress = safeTrim(parts[2]);
    }

    // Tra cứu lịch sử nếu người dùng gõ/nhập tên khớp trong danh sách mà bỏ trống SĐT/Địa chỉ
    if (finalName && (!finalPhone || !finalAddress)) {
      var recipientList = loadRecipientHistory();
      for (var i = 0; i < recipientList.length; i++) {
        var item = recipientList[i];
        if (item.value) {
          var p = item.value.split('|');
          if (p[0] && p[0].toLowerCase() === finalName.toLowerCase()) {
            if (!finalPhone && p[1]) finalPhone = p[1];
            if (!finalAddress && p[2]) finalAddress = p[2];
            break;
          }
        }
      }
    }

    var dialog = buildDocDeliveryDialog(null, finalName, finalPhone, finalAddress, method, note);

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          dialog: dialog
        }
      }
    };
  } catch (error) {
    Logger.log('Error in onNameInputChange: ' + error.message);
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INTERNAL',
            userFacingMessage: 'Lỗi xử lý: ' + error.message
          }
        }
      }
    };
  }
}

function buildDocDeliveryDialog(selectedVal, customName, customPhone, customAddress, methodVal, noteVal) {
  var recipientList = loadRecipientHistory();

  var nameVal = customName || '';
  var phoneVal = customPhone || '';
  var addressVal = customAddress || '';

  if (selectedVal) {
    recipientList.forEach(function (item) {
      item.selected = (item.value === selectedVal);
    });
    var parts = selectedVal.split('|');
    var recName = safeTrim(parts[0] || '');
    var recPhone = safeTrim(parts[1] || '');
    var recAddr = safeTrim(parts[2] || '');

    if (!customName) nameVal = recName;
    if (!customPhone) phoneVal = recPhone;
    if (!customAddress) addressVal = recAddr;
  }

  return {
    body: {
      sections: [
        {
          header: '📦 <b>Đăng ký chuyển phát vật phẩm hồ sơ</b> 🚚\nForm đăng ký:',
          widgets: [
            {
              textInput: {
                name: 'nameInput',
                label: '👤 Họ và tên người nhận (gõ ít nhất 1 ký tự để xổ gợi ý)',
                type: 'SINGLE_LINE',
                value: nameVal,
                autoCompleteAction: {
                  functionName: 'onWidgetUpdate',
                  parameters: [
                    { key: 'action', value: 'onNameAutoComplete' }
                  ]
                },
                onChangeAction: {
                  functionName: 'onCardClick',
                  parameters: [
                    { key: 'action', value: 'onNameInputChange' }
                  ]
                }
              }
            },
            {
              textInput: {
                name: 'phoneInput',
                label: '📞 Số điện thoại người nhận',
                type: 'SINGLE_LINE',
                value: phoneVal
              }
            },
            {
              textInput: {
                name: 'addressInput',
                label: '📍 Địa chỉ người nhận',
                type: 'SINGLE_LINE',
                value: addressVal
              }
            },
            {
              selectionInput: {
                name: 'deliveryMethod',
                label: 'Chuyển phát theo hình thức nào',
                type: 'RADIO_BUTTON',
                items: [
                  { text: 'Qua đường bưu điện (Thời gian nhận dự kiến: 1-3 ngày)', value: 'Qua đường bưu điện (Thời gian nhận dự kiến: 1-3 ngày)', selected: (!methodVal || methodVal === 'Qua đường bưu điện (Thời gian nhận dự kiến: 1-3 ngày)') },
                  { text: 'Qua Grab/GreenSM (nếu thực sự gấp)', value: 'Qua Grab/GreenSM (nếu thực sự gấp)', selected: (methodVal === 'Qua Grab/GreenSM (nếu thực sự gấp)') },
                  { text: 'Qua đường khác... (Nêu chi tiết ở ghi chú phía dưới)', value: 'Qua đường khác... (Nêu chi tiết ở ghi chú phía dưới)', selected: (methodVal === 'Qua đường khác... (Nêu chi tiết ở ghi chú phía dưới)') }
                ]
              }
            },
            {
              textInput: {
                name: 'noteInput',
                label: 'Ghi chú (nếu có)',
                type: 'MULTI_LINE',
                value: ''
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Submit',
                    onClick: {
                      action: {
                        functionName: 'submitDocDelivery',
                        parameters: [
                          { key: 'action', value: 'submitDocDelivery' }
                        ]
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  };
}

function onRecipientSelectChange(event) {
  const formInputs = event.common?.formInputs || {};
  const selectedVal = getValue(formInputs.recipientSelect);
  const methodVal = getValue(formInputs.deliveryMethod);
  const noteVal = getValue(formInputs.noteInput);

  let nameVal = '';
  let phoneVal = '';
  let addressVal = '';

  if (selectedVal) {
    const parts = selectedVal.split('|');
    nameVal = safeTrim(parts[0] || '');
    phoneVal = safeTrim(parts[1] || '');
    addressVal = safeTrim(parts[2] || '');
  }

  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: buildDocDeliveryDialog(selectedVal, nameVal, phoneVal, addressVal, methodVal, noteVal)
      }
    }
  };
}

function submitDocDelivery(event) {
  try {
    const ss = SpreadsheetApp.openById(DOC_DELIVERY_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(DOC_DELIVERY_SHEET_NAME) || ss.getSheetByName('2026');

    if (!sheet) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'NOT_FOUND',
              userFacingMessage: 'Không tìm thấy sheet Chuyển phát hồ sơ!'
            }
          }
        }
      };
    }

    const formInputs = event.common?.formInputs || {};

    const typedName = getValue(formInputs.nameInput);
    const typedPhone = getValue(formInputs.phoneInput);
    const typedAddress = getValue(formInputs.addressInput);
    const deliveryMethod = getValue(formInputs.deliveryMethod) || 'Qua đường bưu điện (Thời gian nhận dự kiến: 1-3 ngày)';
    const note = getValue(formInputs.noteInput) || '';

    let finalName = safeTrim(typedName);
    let finalPhone = safeTrim(typedPhone);
    let finalAddress = safeTrim(typedAddress);

    // Nếu người dùng chọn gợi ý dạng "Tên — SĐT — Địa chỉ", tách ra các trường
    if (finalName && finalName.indexOf(' \u2014 ') !== -1) {
      var suggParts = finalName.split(' \u2014 ');
      finalName = safeTrim(suggParts[0] || '');
      if (!finalPhone && suggParts[1]) finalPhone = safeTrim(suggParts[1]);
      if (!finalAddress && suggParts[2]) finalAddress = safeTrim(suggParts[2]);
    }

    // Tự động tra cứu SĐT và Địa chỉ nếu người dùng gõ tên khớp lịch sử nhưng bỏ trống SĐT/Địa chỉ
    if (finalName && (!finalPhone || !finalAddress)) {
      var recipientList = loadRecipientHistory();
      for (var i = 0; i < recipientList.length; i++) {
        var item = recipientList[i];
        if (item.value) {
          var p = item.value.split('|');
          if (p[0] && p[0].toLowerCase() === finalName.toLowerCase()) {
            if (!finalPhone && p[1]) finalPhone = p[1];
            if (!finalAddress && p[2]) finalAddress = p[2];
            break;
          }
        }
      }
    }

    if (!finalName) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'INVALID_ARGUMENT',
              userFacingMessage: 'Vui lòng chọn hoặc nhập Họ và tên người nhận!'
            }
          }
        }
      };
    }

    if (!finalPhone) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'INVALID_ARGUMENT',
              userFacingMessage: 'Vui lòng nhập Số điện thoại người nhận!'
            }
          }
        }
      };
    }

    if (!finalAddress) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'INVALID_ARGUMENT',
              userFacingMessage: 'Vui lòng nhập Địa chỉ người nhận!'
            }
          }
        }
      };
    }

    const user = event.user.displayName || event.user.email || 'Unknown User';
    const space = event.space?.name;
    const timestamp = getCurrentFormattedDate();

    // Chèn dòng mới lên đầu danh sách (dòng 3, ngay phía dưới dòng tiêu đề cột ở dòng 2)
    sheet.insertRowBefore(3);

    sheet.getRange("A3").setValue(timestamp);
    sheet.getRange("B3").setValue(user);
    sheet.getRange("C3").setValue(finalName);
    sheet.getRange("D3").setValue(finalPhone);
    sheet.getRange("E3").setValue(finalAddress);
    sheet.getRange("F3").setValue(deliveryMethod);
    sheet.getRange("G3").setValue(note);

    // Xóa cache cũ để các lượt gõ gợi ý tiếp theo tự nạp lại danh sách mới nhất
    try {
      CacheService.getScriptCache().remove("RECIPIENT_HISTORY_CACHE");
    } catch (eCacheRem) { }

    var docSheetUrl = 'https://docs.google.com/spreadsheets/d/16OvxNx6hzoaXR9CiKS0d7XuUgNOXrSX5z6mpAcwfHwI/edit?gid=946688501#gid=946688501';

    // Thông báo cho người dùng qua Google Chat
    var mess = "📋 *Đã đăng ký chuyển phát thành công ✅ :*\n" +
      "  • *Người đăng ký:* " + user + "\n" +
      "  • *Hình thức:* " + deliveryMethod + "\n" +
      "  • *Người nhận:* " + finalName + "\n" +
      "  • *Số điện thoại:* " + finalPhone + "\n" +
      "  • *Địa chỉ:* " + finalAddress + "\n" +
      (note ? ("  • *Ghi chú:* " + note) : "");

    if (space) {
      sendMessageByChatBot({ text: mess }, space);
    }

    // Gửi Card thông báo trực tiếp đến không gian 200.Notification (spaces/AAQA2_sKqYQ) giống Đăng ký con dấu
    var notifyWidgets = [
      { textParagraph: { text: '- <b>Người đăng ký</b>: ' + user } },
      { textParagraph: { text: '- <b>Hình thức</b>: ' + deliveryMethod } },
      { textParagraph: { text: '- <b>Người nhận</b>: ' + finalName } },
      { textParagraph: { text: '- <b>Số điện thoại</b>: ' + finalPhone } },
      { textParagraph: { text: '- <b>Địa chỉ</b>: ' + finalAddress } },
      { buttonList: { buttons: [{ text: '📊 Xem Google Sheet', onClick: { openLink: { url: docSheetUrl } } }] } }
    ];
    if (note) {
      notifyWidgets.push({ textParagraph: { text: '- <b>Ghi chú</b>: ' + note } });
    }

    var notifyMsg = {
      cardsV2: [{
        card: {
          header: {
            title: '📦 ĐĂNG KÝ CHUYỂN PHÁT HỒ SƠ',
            subtitle: '⏳ ' + timestamp,
            imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/local_shipping/default/24px.svg'
          },
          sections: [{
            widgets: notifyWidgets
          }],
          fixedFooter: {
            primaryButton: {
              text: 'Xem Google Sheet',
              onClick: {
                openLink: {
                  url: docSheetUrl
                }
              }
            }
          }
        }
      }]
    };

    sendMessageByChatBot(notifyMsg, 'spaces/AAQA2_sKqYQ');
    Logger.log('submitDocDelivery: Gửi thẻ thông báo đến 200.Notification (spaces/AAQA2_sKqYQ)');

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'OK',
            userFacingMessage: 'Đăng ký chuyển phát hồ sơ thành công!'
          }
        }
      }
    };

  } catch (error) {
    Logger.log('submitDocDelivery error: ' + error.message);
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INTERNAL',
            userFacingMessage: 'Có lỗi xảy ra: ' + error.message
          }
        }
      }
    };
  }
}

/**
 * Gửi lại thông báo OT cho 1 dòng cụ thể trong sheet "2026".
 * Cách dùng: Mở Apps Script Editor → chọn hàm này → chạy thủ công.
 *
 * @param {number} rowIndex  Số dòng trong sheet (ví dụ: 28 = dòng 28)
 *
 * Cấu trúc sheet "2026":
 *   Col A: Timestamp
 *   Col C: Họ và tên (employee)
 *   Col D: Ngày OT       (format d/M/yyyy  hoặc Date object)
 *   Col E: Days of week
 *   Col F: From (giờ bắt đầu, ví dụ "06:00 PM")
 *   Col G: To   (giờ kết thúc)
 *   Col H: Department (200 / 300 / 500 / 600)
 *   Col I: Dự án
 *   Col J: Nội dung công việc
 *   Col K: Công ty
 *   Col L: Accept by Manager ("ok" = đã duyệt)
 */
function resendOTNotification(rowIndex) {
  try {
    if (!rowIndex || rowIndex < 2) {
      Logger.log('❌ rowIndex không hợp lệ: ' + rowIndex);
      return;
    }

    const ss = SpreadsheetApp.openById('1V6KdebLwMcL7TEaF-UmSGtAB_JBExRP_yw6MA8HOSmU');
    const currentYear = new Date().getFullYear().toString();
    const sheet = ss.getSheetByName(currentYear) || ss.getSheetByName('2026');

    if (!sheet) {
      Logger.log('❌ Không tìm thấy sheet "2026"');
      return;
    }

    // Đọc dữ liệu từ dòng rowIndex (14 cột: A→N)
    const row = sheet.getRange(rowIndex, 1, 1, 14).getValues()[0];

    // Map cột (index 0-based vì là mảng)
    const employee = String(row[2] || '').trim();   // Col C
    const rawDate = row[3];                          // Col D: Date object hoặc string
    const timeFrom = String(row[5] || '').trim();   // Col F: From
    const timeTo = String(row[6] || '').trim();   // Col G: To
    const department = String(row[7] || '').trim();   // Col H: Department
    const project = String(row[8] || '').trim();   // Col I: Dự án
    const content = String(row[9] || '').trim();   // Col J: Nội dung
    const company = String(row[10] || '').trim();  // Col K: Công ty

    if (!employee || !rawDate || !timeFrom || !timeTo || !department) {
      Logger.log('❌ Dữ liệu dòng ' + rowIndex + ' thiếu thông tin: ' +
        JSON.stringify({ employee, rawDate, timeFrom, timeTo, department }));
      return;
    }

    // Chuyển ngày sang chuỗi dd/MM/yyyy để hiển thị
    var dateDisplay = '';
    if (rawDate instanceof Date) {
      dateDisplay = convertToDDMMYYYY(
        rawDate.getDate() + '/' + (rawDate.getMonth() + 1) + '/' + rawDate.getFullYear()
      );
    } else {
      dateDisplay = convertToDDMMYYYY(String(rawDate).trim());
    }

    // Xác định spaceManager theo department
    var spaceManager = '';
    if (department == '200' || department == '300') {
      spaceManager = 'spaces/6Udkg8AAAAE';
    } else if (department == '500') {
      spaceManager = 'spaces/_mfTYCAAAAE';
    } else if (department == '600') {
      spaceManager = 'spaces/-jG9ACAAAAE';
    } else {
      Logger.log('⚠️ Department "' + department + '" không có spaceManager tương ứng. Bỏ qua.');
      return;
    }

    const rangeDisplay = timeFrom + ' - ' + timeTo + ' (' + dateDisplay + ')';

    const message = {
      cardsV2: [{
        card: {
          header: {
            title: 'OVERTIME REGISTRATION (Resend)',
            imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/info/default/24px.svg'
          },
          sections: [{
            widgets: [{
              textParagraph: { text: '- <b>Staff</b>: ' + employee }
            }, {
              textParagraph: { text: '- <b>Rangetime</b>: ' + rangeDisplay }
            }, {
              textParagraph: { text: '- <b>Project</b>: ' + project }
            }, {
              textParagraph: { text: '- <b>Work</b>: ' + content + '\n' }
            }, {
              buttonList: {
                buttons: [
                  {
                    text: 'ACCEPT✅',
                    onClick: {
                      action: {
                        'function': 'approveOvertime',
                        parameters: [
                          { key: 'action', value: 'approveOvertime' },
                          { key: 'staff', value: employee },
                          { key: 'rangetime', value: rangeDisplay },
                          { key: 'project', value: project },
                          { key: 'work', value: content },
                          { key: 'index', value: String(rowIndex) },
                          { key: 'space', value: '' },
                          { key: 'spaceleader', value: spaceManager }
                        ]
                      }
                    }
                  },
                  {
                    text: 'REJECT❌',
                    onClick: {
                      action: {
                        'function': 'rejectOvertime',
                        parameters: [
                          { key: 'action', value: 'rejectOvertime' },
                          { key: 'staff', value: employee },
                          { key: 'rangetime', value: rangeDisplay },
                          { key: 'project', value: project },
                          { key: 'work', value: content },
                          { key: 'index', value: String(rowIndex) },
                          { key: 'space', value: '' },
                          { key: 'spaceleader', value: spaceManager }
                        ]
                      }
                    }
                  }
                ]
              }
            }]
          }]
        }
      }],
      accessoryWidgets: [{
        buttonList: {
          buttons: [{
            text: 'Open Google Sheet for details',
            icon: { materialIcon: { name: 'link' } },
            onClick: {
              openLink: {
                url: 'https://docs.google.com/spreadsheets/d/1V6KdebLwMcL7TEaF-UmSGtAB_JBExRP_yw6MA8HOSmU/edit?gid=1995509897#gid=1995509897'
              }
            }
          }]
        }
      }]
    };

    sendMessageByChatBot(message, spaceManager);
    Logger.log('✅ Đã gửi lại thông báo OT dòng ' + rowIndex + ' cho ' + employee +
      ' → ' + spaceManager);

  } catch (error) {
    Logger.log('❌ resendOTNotification error: ' + error.message);
    if (error.stack) Logger.log(error.stack);
  }
}

/**
 * ✅ WRAPPER ĐỂ CHẠY TRỰC TIẾP TỪ APPS SCRIPT EDITOR
 * Cách dùng:
 *   1. Sửa biến ROW_TO_RESEND thành số dòng muốn gửi lại (xem số dòng trong sheet "2026")
 *   2. Chọn hàm "runResendOT" ở dropdown
 *   3. Nhấn ▶ Run
 */
function runResendOT() {
  var ROW_TO_RESEND = 10; // ← SỬA SỐ DÒNG Ở ĐÂY (dòng trong sheet "2026")

  Logger.log('🚀 Bắt đầu gửi lại OT cho dòng: ' + ROW_TO_RESEND);
  resendOTNotification(ROW_TO_RESEND);
}

//===================================================== IMPORTANT - ĐANG CHẠY ỔN THÌ ĐỪNG ĐỤNG VÀO =====================================================
// LƯU Ý: CREDENTIALS đọc từ Script Properties. Chạy hàm setupSecrets() một lần để khởi tạo.

function getCredentials_() {
  var credJson = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_CREDENTIALS');
  if (!credJson) throw new Error('SERVICE_ACCOUNT_CREDENTIALS chưa được cấu hình. Chạy hàm setupSecrets() trước.');
  return JSON.parse(credJson);
}

const SCOPE = 'https://www.googleapis.com/auth/chat.bot';

function sendMessageByChatBot(message, spaceId) {
  try {
    const service = getService_();
    if (!service.hasAccess()) {
      return;
    }

    var messId = Chat.Spaces.Messages.create(
      message,
      spaceId,
      {},
      { 'Authorization': 'Bearer ' + service.getAccessToken() });

    return {
      name: messId.name,
      createTime: messId.createTime
    }

  } catch (err) {

    console.log('Failed to create message with error %s', err.message);
  }
}

function getService_() {
  var creds = getCredentials_();
  return OAuth2.createService(creds.client_email)
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(creds.private_key)
    .setIssuer(creds.client_email)
    .setSubject(creds.client_email)
    .setScope(SCOPE)
    .setPropertyStore(PropertiesService.getScriptProperties());
}

function sendMessageByUser(spaceId, message) {
  Chat.Spaces.Messages.create(message, spaceId, {});
}

function tesstt() {
  const message = {
    text: "QUOTED kekeke",
    quotedMessageMetadata: {
      name: 'spaces/sx4DQsAAAAE/messages/_7k_azIyWPU._7k_azIyWPU',
      lastUpdateTime: '2025-09-26T07:29:17.280495Z',
    }
  }

  sendMessageByUser("spaces/sx4DQsAAAAE", message)
}

function kakaka() {
  const service = getService_();
  if (!service.hasAccess()) {
    return;
  }

  var mess = {
    text: "hello HR",
    quotedMessageMetadata: {
      name: 'spaces/7zKRg8AAAAE/messages/hv14LqxPmPo.hv14LqxPmPo',
      lastUpdateTime: '2025-09-26T07:45:20.570271Z',
    }
  }

  let messId = sendMessageByChatBot(mess, "spaces/7zKRg8AAAAE")



  console.log(messId)
}

function hejhej() {
  const message = {
    text: 'Text updated with app credential!',
    cardsV2: [{
      card: {
        header: {
          title: 'Card updated with app credential!',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/info/default/24px.svg'
        }
      }
    }]
  };

  let messId = sendMessageByChatBot(message, "spaces/7zKRg8AAAAE")

  console.log(messId)

}

function updateeee() {
  const service = getService_();
  const message = {
    text: 'kakakakaka',
    cardsV2: [{
      card: {
        header: {
          title: 'Phai gi!',
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/info/default/24px.svg'
        }
      }
    }]
  };

  const updateMask = 'text,cardsV2';

  const response = Chat.Spaces.Messages.patch(message, 'spaces/7zKRg8AAAAE/messages/XrNYLA5TQq0.XrNYLA5TQq0', {
    updateMask: updateMask
  }, { 'Authorization': 'Bearer ' + service.getAccessToken() });

  console.log(response)
}

//=====================================================================================================================================================================


function convertToDDMMYYYY(dateStr) {
  // dateStr dạng "mm/dd/yyyy"
  const parts = dateStr.split("/"); // [mm, dd, yyyy]
  const mm = parts[0];
  const dd = parts[1];
  const yyyy = parts[2];

  return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
}

function getDayOfWeek(dateStr) {
  // dateStr dạng "9/15/2025"
  const parts = dateStr.split("/"); // ["9","15","2025"]
  const month = parseInt(parts[0], 10) - 1; // tháng trong JS bắt đầu từ 0
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);

  const date = new Date(year, month, day);

  // Lấy số thứ trong tuần (0 = Chủ Nhật, 1 = Thứ Hai, ..., 6 = Thứ Bảy)
  const dayIndex = date.getDay();

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dayIndex];
}


function convertMsToDateTime(ms) {
  if (!ms) return '';
  // formatDate: h = giờ 12h, a = AM/PM
  return Utilities.formatDate(new Date(Number(ms)), "GMT+0", "MM/dd/yyyy h:mm:ss a");
}



function getNowFormatted() {
  // Lấy giờ hiện tại (theo giờ Việt Nam GMT+7)
  const now = new Date();

  // Format: M/d/yyyy HH:mm:ss
  const formatted = Utilities.formatDate(now, "GMT+7", "M/d/yyyy HH:mm:ss");

  return formatted;
}

// Hàm phụ để lấy value từ formInputs (do có key rỗng)
function getValue(input) {
  if (!input) return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const stringInputs = input[keys[0]]?.stringInputs;
  return stringInputs?.value?.[0] || '';
}


// Hàm thiết lập Google Sheet
// function setupSheet() {
//   try {
//     var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
//     if (!sheet.getRange('A1:E1').getValues()[0].filter(String).length) {
//       sheet.getRange('A1:E1').setValues([['Timestamp', 'User', 'PenaltyOrBonus', 'Point', 'Reason']]);
//     }
//     Logger.log('Setup sheet completed');
//   } catch (error) {
//     Logger.log('Error in setupSheet: ' + error.message);
//   }
// }

function getLastRowInColumn(sheet, column) {
  if (!sheet) return 0;
  try {
    var lastRow = sheet.getLastRow();
    if (lastRow <= 0) return 0;
    var values = sheet.getRange(1, column, lastRow).getValues();

    for (var i = values.length - 1; i >= 0; i--) {
      if (values[i][0] != '') {
        return i + 1; // vì chỉ số mảng bắt đầu từ 0
      }
    }
  } catch (e) {
    Logger.log('Error in getLastRowInColumn: ' + e.message);
  }
  return 0; // nếu không có dữ liệu hoặc gặp lỗi
}

//==================================================AUTHOR========================================================
// LƯU Ý: CLIENT_ID và CLIENT_SECRET đọc từ Script Properties. Chạy setupSecrets() để khởi tạo.

function getOAuthService() {
  return OAuth2.createService('chatbot')
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_ID'))
    .setClientSecret(PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('https://www.googleapis.com/auth/chat.messages')
    .setParam('access_type', 'offline');
}

function authCallback(request) {
  const service = getOAuthService();
  const authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput('✅ Authorization successful!');
  } else {
    return HtmlService.createHtmlOutput('❌ Authorization denied');
  }
}

function authorize() {
  const service = getOAuthService();
  if (!service.hasAccess()) {
    const authorizationUrl = service.getAuthorizationUrl();
    Logger.log('Open the following URL to authorize this script: %s', authorizationUrl);
  } else {
    Logger.log('✅ Already authorized');
  }
}

function resetOAuthToken() {
  var service = getOAuthService();
  service.reset();
  Logger.log("OAuth token has been reset. Run your function again to re-authorize.");
}


//==============================SEND======================================

function sendMessageToSpace(usernames = '', point = '', reason = '', space = '') {
  const service = getOAuthService();
  const url = `https://chat.googleapis.com/v1/${space}/messages`;


  var mess = ''

  if (usernames.length > 20) {
    mess = usernames
  } else {

    if (usernames == '' && point == '' && reason == '') {
      mess = "Bạn đã đăng ký thành công ✅ <https://docs.google.com/spreadsheets/d/10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ/edit?gid=617945518#gid=617945518|Xem chi tiết>"
    } else {

      const pointAbs = Math.abs(parseInt(point));
      let pointDisplay = "";
      let sign = " + ";
      if (parseInt(point) > 0) {
        sign = " + ";
        pointDisplay = pointAbs + " ❤️";
      } else if (parseInt(point) < 0) {
        sign = " - ";
        pointDisplay = pointAbs + " 💣";
      }

      let displayReason = "";
      if (reason && reason.trim() !== "") {
        displayReason = ". *Reason:* " + reason;
      }
      mess = "*" + standForName(usernames) + "*" + sign + "*" + pointDisplay + "*" + displayReason + "."
    }
  }


  const payload = {
    text: mess
  };

  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      Authorization: 'Bearer ' + service.getAccessToken()
    },
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

function generateRandomCode() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var result = '';
  for (var i = 0; i < 4; i++) {
    var randomIndex = Math.floor(Math.random() * chars.length);
    result += chars.charAt(randomIndex);
  }

  return result;
}


// function sendEmailOvertime (email, staff = '', company = '', department = '', project = '', content = '', day = '', start = '', end = '', space = '') {
//   const url = "https://script.google.com/a/macros/planadd.com/s/AKfycbxQzGDdrdmedVf4lUtHsD1F9uyUZTDsT869eG5s-5UICcm9k9X6HUmmDpfxLyAzx1oz/exec"

//   let approveUrl = url
//   + "?action=approve"
//   + "&staff=" + encodeURIComponent(staff)
//   + "&day="   + encodeURIComponent(day)
//   + "&space=" + encodeURIComponent(space)
//   + "&project=" + encodeURIComponent(project)
//   + "&content=" + encodeURIComponent(content)
//   + "&timeStart=" + encodeURIComponent(start)
//   + "&timeEnd=" + encodeURIComponent(end)

//   let rejectUrl = url
//     + "?action=reject"
//     + "&staff=" + encodeURIComponent(staff)
//     + "&day="   + encodeURIComponent(day)
//     + "&space=" + encodeURIComponent(space)
//     + "&project=" + encodeURIComponent(project)
//     + "&content=" + encodeURIComponent(content)
//     + "&timeStart=" + encodeURIComponent(start)
//     + "&timeEnd=" + encodeURIComponent(end)



//   let text = `
//     <p style="color:red;">Vui lòng phê duyệt thủ công <a href="https://docs.google.com/spreadsheets/d/1V6KdebLwMcL7TEaF-UmSGtAB_JBExRP_yw6MA8HOSmU/edit?gid=1995509897#gid=1995509897" target="_blank">tại đây</a></p>hoặc chọn:
//     <p>
//       <a href="${approveUrl}" 
//         style="background-color:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">
//         Chấp nhận
//       </a>
//       <a href="${rejectUrl}" 
//         style="background-color:#dc3545;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">
//         Không duyệt
//       </a>
//     </p>
//     <p>Tóm tắt:</p>
//     <ul>
//       <li><b>Người yêu cầu:</b> ${staff}</li>
//       <li><b>Ngày đăng ký:</b> ${day}</li>
//       <li><b>Thời gian:</b> ${start} - ${end}</li>
//       <li><b>Dự án:</b> ${project}</li>
//       <li><b>Nội dung công việc:</b> ${content}</li>
//     </ul>
//     <p>-----<br>Email tự động từ 200 AI.</p>
//   `


//   MailApp.sendEmail({
//     to: email.trim(),
//     subject: 'Xét Duyệt Đăng Ký Tăng Ca ' + company + "-" + department,
//     htmlBody: text
//   });
// }

function sendEmail(email, user = '', vpp = '', count = '', link = '') {
  let text = ''
  if (link == '') {
    text = `
      <p><b>Người gửi:</b> ${user}</p>
      <p><b>Văn phòng phẩm:</b> ${vpp}</p>
      <p><b>Số lượng:</b> ${count}</p>
      <p>Xem chi tiết <a href="https://docs.google.com/spreadsheets/d/10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ/edit?gid=1002024016#gid=1002024016" target="_blank">tại đây</a>.</p>
      <p>-----<br>Email tự động từ 200 AI.</p>
    `
  } else {
    text = `
      <p><b>Người gửi:</b> ${user}</p>
      <p><b>Văn phòng phẩm:</b> ${vpp}</p>
      <p><b>Số lượng:</b> ${count}</p>
      <p><a href="${link}" target="_blank">Link sản phẩm</a></p>
      <p>Xem chi tiết <a href="https://docs.google.com/spreadsheets/d/10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ/edit?gid=1002024016#gid=1002024016" target="_blank">tại đây</a>.</p>
      <p>-----<br>Email tự động từ 200 AI.</p>
    `
  }


  MailApp.sendEmail({
    to: email,
    subject: 'Yêu cầu đăng ký văn phòng phẩm - ' + generateRandomCode(),
    htmlBody: text
  });
}

function sendEmailDocDelivery(email, user = '', recipient = '', phone = '', address = '', deliveryMethod = '', note = '') {
  const code = generateRandomCode();
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${DOC_DELIVERY_SPREADSHEET_ID}/edit?gid=946688501#gid=946688501`;
  let text = '<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.3;">' +
    '<b>Người đăng ký:</b> ' + user + '<br>' +
    '<b>Hình thức:</b> ' + deliveryMethod + '<br>' +
    '<br>' +
    '<b>Người nhận:</b> ' + recipient + '<br>' +
    '<b>Số điện thoại:</b> ' + phone + '<br>' +
    '<b>Địa chỉ:</b> ' + address + '<br>' +
    (note ? ('<b>Ghi chú:</b> ' + note + '<br>') : '') +
    '<div style="margin-top: 6px;"><a href="' + sheetUrl + '" target="_blank" style="color: #1a73e8; font-weight: bold;">Xem chi tiết tại đây</a></div>' +
    '<hr style="border: none; border-top: 1px solid #ccc; margin: 10px 0 6px 0;">' +
    '<div style="font-size: 12px; color: #777;">Email tự động từ 200 AI.</div>' +
    '</div>';

  MailApp.sendEmail({
    to: email,
    subject: 'Đăng ký chuyển phát hồ sơ - ' + user + ' - ' + code,
    htmlBody: text
  });
}


function standForName(username) {
  if (typeof username === 'string') {
    return username;
  }
  if (Array.isArray(username)) {
    return username.join(', ');
  }
  return String(username || '');
}


function companyRule() {
  return `
    CHƯƠNG 1: QUY ĐỊNH VỀ GIỜ LÀM VIỆC
Điều 1  [Thời gian làm việc hành chính ]
1. Thời gian làm việc hành chính: 8 tiếng/ ngày, tổng cộng 44 tiếng/ tuần
2. sáng: từ 8:00 ~ 12:00. chiều: từ 13:30 – 17:30.
Ngày làm việc trong tuần: Các ngày làm việc trong tuần: từ thứ 2 đến thứ 6 và một số ngày thứ 7 trong tháng (Nếu tháng đó có 4 thứ 7, nhân viên cần đảm bảo làm đi làm đủ 2 thứ 7. Còn nếu có 5 thứ 7 thì cần đảm bảo làm việc đủ 3 thứ 7 trong tháng), theo sự sắp xếp của trưởng bộ phận để đảm bảo số giờ công làm việc 44 tiếng/ tuần. Riêng công trường theo yêu cầu công việc, đảm bảo tổng thời gian làm việc trong không quá 8 tiếng/ ngày, không quá 44 tiếng/ tuần.
Đối với nhân viên nữ nuôi con dưới 1 tuổi được hưởng 1 tiếng nghỉ/ ngày theo quy định của luật lao động. Thời gian cụ thể phải có sự thoả thuận với cấp quản lý và phòng nhân sự.
Điều 2 [Xử phạt lỗi đi muộn, về sớm]
Mỗi lần bị trừ sẽ cộng dồn đến cuối tháng
10.1. Tổng thời gian đi muộn/ về sớm trong tháng không được quá 4h hoặc tối đa 6 lần.
Hình thức xử lý nếu nhân viên có tổng thời gian đi muộn vượt quá 4h hoặc vượt quá 6 lần trong tháng:
- Trừ 0.5 ngày công
- Cứ mỗi lần tiếp tục đi muộn quá 30 phút hoặc cứ mỗi 3 lần đi muộn tiếp theo sẽ bị trừ 0.5 ngày công (phải đủ 3 lần mới bị trừ công, nếu không đủ 3 lần sẽ không bị trừ). Trong đó, sẽ có 3 lần/tháng nhân viên được giải trình công trong trường hợp đi muộn trong vòng 15 phút vì một số lý do đặc biệt như tắc đường, hỏng xe, ốm... 3 lần này sẽ không tính là đi muộn. Tuy nhiên, nếu đến lần thứ 4 lý do đặc biệt này sẽ không còn được chấp nhận được, sẽ tính là 1 lần đi muộn từ lần 4 đó. (Ví dụ: Tháng này tôi đi muộn 10 lần, trong đó có 4 lần tôi xin phép do tắc đường. Nhưng công ty chỉ chấp nhận 3 lần với lí do nên tôi đi muộn 7 lần.)
Ví dụ 1: Tháng này tôi đi muộn 10 lần, tôi bị trừ bao nhiêu công
Câu trả lời: Số lần đi muộn: Tổng cộng bạn có 10 lần đi muộn.
Xử lý vi phạm: Bạn đã vượt quá 6 lần đi muộn không có phép. Theo quy định, bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên. Với 4 lần đi muộn tiếp theo (từ lần thứ 7 đến lần thứ 10), bạn sẽ bị trừ thêm 0.5 ngày công cho mỗi 3 lần. Cụ thể:
Lần thứ 7, 8, 9: trừ 0.5 ngày công.
Lần thứ 10: không đủ 3 ngày để trừ thêm 0.5 ngày công.
Tổng cộng, bạn sẽ bị trừ 1 ngày công (0.5 ngày cho 6 lần đầu tiên và 0.5 ngày cho 4 lần tiếp theo).
Ví dụ 1.1: Tháng vừa rồi tôi đi muộn 9 lần, tôi có bị trừ công không
Câu trả lời: Số lần đi muộn: Tổng cộng bạn có 9 lần đi muộn.
Xử lý vi phạm: Bạn đã vượt quá 6 lần đi muộn không có phép. Theo quy định, bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên. Với 3 lần đi muộn tiếp theo (từ lần thứ 7 đến lần thứ 10), bạn sẽ bị trừ thêm 0.5 ngày công cho mỗi 3 lần. Cụ thể:
Lần thứ 7, 8, 9: trừ 0.5 ngày công.
Tổng cộng, bạn sẽ bị trừ 1 ngày công.

Ví dụ 2: Tháng này tôi đi muộn 12 lần, tôi bị trừ bao nhiêu công
Câu trả lời: Nếu bạn đi muộn 12 lần trong tháng, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Tổng cộng bạn có 12 lần đi muộn.
Xử lý vi phạm: Bạn đã vượt quá 6 lần đi muộn không có phép. Theo quy định, bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên. Với 6 lần đi muộn tiếp theo (từ lần thứ 7 đến lần thứ 12), bạn sẽ bị trừ thêm 0.5 ngày công cho mỗi 3 lần. Cụ thể:
Lần thứ 7, 8, 9: trừ 0.5 ngày công.
Lần thứ 10, 11, 12: trừ 0.5 ngày công.
Tổng cộng, bạn sẽ bị trừ 1.5 ngày công (0.5 ngày cho 6 lần đầu tiên và 1 ngày cho 6 lần tiếp theo).

Ví dụ 3: Tháng này tôi đi muộn 13 lần, tôi bị trừ bao nhiêu công
Câu trả lời: Nếu bạn đi muộn 13 lần trong tháng, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Tổng cộng bạn có 13 lần đi muộn.
Xử lý vi phạm: Bạn đã vượt quá 6 lần đi muộn không có phép. Theo quy định, bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Với 7 lần đi muộn tiếp theo (từ lần thứ 7 đến lần thứ 13), bạn sẽ bị trừ thêm 0.5 ngày công cho mỗi 3 lần. Cụ thể:
Lần thứ 7, 8, 9: trừ 0.5 ngày công.
Lần thứ 10, 11, 12: trừ 0.5 ngày công.
Lần thứ 13: không đủ 3 ngày để trừ thêm 0.5 ngày công.
Tổng cộng, bạn sẽ bị trừ 1.5 ngày công (0.5 ngày cho 5 lần đầu tiên và 1 ngày cho 7 lần tiếp theo).

Ví dụ 4: Tháng vừa rồi tôi đi làm muộn 9 lần, tôi sẽ bị trừ bao nhiêu ngày công? (trong đó 3 lần tôi đến muộn do tắc đường, đau bụng, bị ốm,...)
Câu trả lời: Nếu bạn đi muộn 9 lần trong tháng, trong đó có 3 lần xin phép, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Bạn có 9 lần đi muộn, 3 lần trong số đó đã được xin phép mà 1 tháng công ty chấp nhận tối đa 3 lần xin phép do đó chỉ còn lại 6 lần đi muộn không có phép.
Xử lý vi phạm:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Tổng cộng: 6 lần đầu tiên: Trừ 0.5 ngày công.
Vậy bạn sẽ bị trừ tổng cộng 0.5 ngày công.

Ví dụ 5: Tháng vừa rồi tôi đi làm muộn 10 lần, tôi sẽ bị trừ bao nhiêu ngày công? (trong đó 3 lần tôi đến muộn do tắc đường, đau bụng, bị ốm,...)
Câu trả lời: Nếu bạn đi muộn 10 lần trong tháng, trong đó có 3 lần xin phép, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Bạn có 10 lần đi muộn, 3 lần trong số đó đã được xin phép mà 1 tháng công ty chấp nhận tối đa 3 lần xin phép do đó chỉ còn lại 7 lần đi muộn không có phép.
Xử lý vi phạm:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Tổng cộng: 6 lần đầu tiên: Trừ 0.5 ngày công.
Lần thứ 7: không đủ 3 ngày để trừ thêm 0.5 công.
Vậy bạn sẽ bị trừ tổng cộng 0.5 ngày công.
Ví dụ 6: Tháng vừa rồi tôi đi làm muộn 14 lần, tôi sẽ bị trừ bao nhiêu ngày công? (trong đó 3 lần tôi đến muộn do tắc đường, đau bụng, bị ốm,...)
Câu trả lời: Nếu bạn đi muộn 15 lần trong tháng, trong đó có 3 lần xin phép, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Bạn có 14 lần đi muộn, 3 lần trong số đó đã được xin phép mà 1 tháng công ty chấp nhận tối đa 3 lần xin phép do đó chỉ còn lại 11 lần đi muộn không có phép.
Xử lý vi phạm:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Tổng cộng: 6 lần đầu tiên: Trừ 0.5 ngày công.
Lần thứ 7, 8, 9: trừ 0.5 công.
Lần 10, 11: không đủ 3 ngày để trừ công
Vậy bạn sẽ bị trừ tổng cộng 1 ngày công.

Ví dụ 7: Tháng vừa rồi tôi đi làm muộn 9 lần, tôi sẽ bị trừ bao nhiêu ngày công? (trong đó 4 lần tôi đến muộn do tắc đường, đau bụng, bị ốm,...)
Câu trả lời: Nếu bạn đi muộn 9 lần trong tháng, trong đó có 4 lần xin phép, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Bạn có 9 lần đi muộn, trong đó có 4 lần trong số đó đã được xin phép nhưng trong 1 tháng công ty chỉ chấp nhận tối đa 3 lần có phép. Nên bạn đi muộn 9 - 3 = 6 lần
Xử lý vi phạm:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Vì vậy, bạn sẽ bị trừ tổng cộng 0.5 ngày công.

Ví dụ 8: Tháng vừa rồi tôi đi làm muộn 11 lần, tôi sẽ bị trừ bao nhiêu ngày công? (trong đó 4 lần tôi đến muộn do tắc đường, đau bụng, bị ốm,...)
Câu trả lời: Nếu bạn đi muộn 11 lần trong tháng, trong đó có 4 lần xin phép, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Bạn có 11 lần đi muộn, trong đó có 4 lần trong số đó đã được xin phép nhưng trong 1 tháng công ty chỉ chấp nhận tối đa 3 lần có phép. Nên bạn đi muộn 11 - 3 = 8 lần
Xử lý vi phạm:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8: Không đủ 3 ngày để trừ thêm 0.5 công
Vì vậy, bạn sẽ bị trừ tổng cộng 0.5 ngày công.

Ví dụ 9: Tháng vừa rồi tôi đi làm muộn 13 lần, tôi sẽ bị trừ bao nhiêu ngày công? (trong đó 5 lần tôi đến muộn do tắc đường, đau bụng, bị ốm,...)
Câu trả lời: Nếu bạn đi muộn 13 lần trong tháng, trong đó có 5 lần xin phép, bạn sẽ bị xử lý như sau:
Số lần đi muộn: Bạn có 13 lần đi muộn, trong đó có 5 lần trong số đó đã được xin phép nhưng trong 1 tháng công ty chỉ chấp nhận tối đa 3 lần có phép. Nên bạn đi muộn 13 - 3 = 10 lần
Xử lý vi phạm:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8, 9: Bạn bị trừ 0.5 công
Lần thứ 10: Không đủ 3 ngày để trừ công
Vì vậy, bạn sẽ bị trừ tổng cộng 1 ngày công.
* Với hình thức về sớm vẫn xử lý như khi đi muộn. Ví dụ: Tháng này tôi đi muộn 5 lần, về sớm 7 lần. Tôi sẽ bị xử lý như sau: Tôi sẽ có tổng là 5+7=12 lần đi muộn, về sớm. Với 6 lần đầu tôi bị trừ 0.5 công. 6 ngày còn lại, với 3 lần (lần 7, 8, 9), tôi bị trừ 0.5 công. Với 3 lần tiếp theo (lần 10, 11, 12), tôi bị trừ 0.5 công. Tổng cộng tôi bị trừ 0.5+0.5+0.5 = 1.5 công

Ví dụ 10: Tháng này tôi đi muộn 5 lần, về sớm 7 lần, tôi bị phạt như thế nào? (Trong đó có 3 lần tôi có xin phép)
Câu trả lời: Bạn sẽ có tổng là 5+7=12 lần đi muộn, về sớm. Trong đó có 3 lần bạn xin phép nên tôi còn 12 - 3 = 9 lần đi muộn, về sớm. Bạn sẽ bị xử lý như sau:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8, 9: Bạn bị trừ 0.5 công
Vì vậy, bạn sẽ bị trừ tổng cộng 1 ngày công.

Ví dụ 11: Tháng này tôi đi muộn 6 lần, về sớm 6 lần, tôi bị phạt như thế nào? (Trong đó có 4 lần tôi có xin phép)
Câu trả lời: Bạn sẽ có tổng là 6+6=12 lần đi muộn, về sớm. Trong đó có 4 lần bạn xin phép nhưng công ty chỉ chấp nhận 3 lần nên tôi còn 12 - 3 = 9 lần đi muộn, về sớm. Bạn sẽ bị xử lý như sau:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8, 9: Bạn bị trừ 0.5 công
Vì vậy, bạn sẽ bị trừ tổng cộng 1 ngày công.

Ví dụ 12: Tháng này tôi đi muộn 8 lần, về sớm 5 lần, tôi bị phạt như thế nào? (Trong đó có 5 lần tôi có xin phép)
Câu trả lời: Bạn sẽ có tổng là 8+5=13 lần đi muộn, về sớm. Trong đó có 5 lần bạn xin phép nhưng công ty chỉ chấp nhận 3 lần nên tôi còn 13 - 3 = 10 lần đi muộn, về sớm. Bạn sẽ bị xử lý như sau:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8, 9: Bạn bị trừ 0.5 công
Lần thứ 10: Không đủ 3 ngày để trừ công
Vì vậy, bạn sẽ bị trừ tổng cộng 1 ngày công.

Ví dụ 13: Tháng này về sớm 13 lần, tôi bị phạt như thế nào? (Trong đó có 5 lần tôi có xin phép)
Câu trả lời: Bạn sẽ có 13 lần về sớm. Trong đó có 5 lần bạn xin phép nhưng công ty chỉ chấp nhận 3 lần nên tôi còn 13 - 3 = 10 lần về sớm. Bạn sẽ bị xử lý như sau:
Tổng thời gian đi muộn của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8, 9: Bạn bị trừ 0.5 công
Lần thứ 10: Không đủ 3 ngày để trừ công
Vì vậy, bạn sẽ bị trừ tổng cộng 1 ngày công.

Ví dụ 14: Tháng này tôi đi muộn về sớm 10 lần, tôi bị phạt như thế nào? 
Câu trả lời: Bạn sẽ bị xử lý như sau:
Tổng thời gian đi muộn về sớm của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8, 9: Bạn bị trừ 0.5 công
Lần thứ 10: Không đủ 3 ngày để trừ công
Vì vậy, bạn sẽ bị trừ tổng cộng 1 ngày công.

Ví dụ 15: Tháng này tôi đi muộn về sớm 10 lần, tôi bị phạt như thế nào? (3 lần xin phép)
Câu trả lời: Bạn đã đi muộn về sớm 10 lần, trong đó có 3 lần xin phép nên bạn đi muộn về sớm 10 - 3 = 7 lần trong tháng. Bạn sẽ bị xử lý như sau: 
Tổng thời gian đi muộn về sớm của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7: Không đủ 3 ngày để trừ công
Vì vậy, bạn sẽ bị trừ tổng cộng 0.5 ngày công.

Ví dụ 16: Tháng này về sớm 13 lần, tôi bị phạt như thế nào? 
Câu trả lời:  Bạn sẽ bị xử lý như sau:
Tổng thời gian về sớm của bạn đã vượt quá 6 lần, do đó bạn sẽ bị trừ 0.5 ngày công cho 6 lần đầu tiên.
Lần thứ 7, 8, 9: Bạn bị trừ 0.5 công
Lần thứ 10, 11, 12: Bạn bị trừ 0.5 công
Lần thứ 13: Không đủ 3 ngày để trừ công
Vì vậy, bạn sẽ bị trừ tổng cộng 1,5 ngày công.

Ví dụ 17: Tôi đến trễ 8 lần trong tháng vừa rồi (3 lần tắc đường), tôi có bị phạt không?
Câu trả lời: Bạn đã đi muộn 8 lần, trong đó có 3 lần xin phép nên bạn đi muộn về sớm 8 - 3 = 5 lần trong tháng. Bạn sẽ bị xử lý như sau:
Tổng thời gian đi muộn của bạn đã chưa quá 6 lần, nên bạn không bị trừ công.
Vì vậy, bạn sẽ bị không bị trừ công.

10.2. Các trường hợp không được tính ngày công:
- Bị trừ 0.5 ngày công nếu:
+ Đi làm muộn/ về sớm quá 1h (trong ngày) không có phép.
+ Đi làm muộn/ về sớm quá 2h (trong ngày) có phép.
+ 03 lần quên chấm công trong tháng.
- Bị trừ 01 ngày công nếu:
+ Tự ý nghỉ 01 buổi không có phép.
+ 05 lần quên chấm công trong tháng.
Ngoài ra nhân viên sẽ bị xem xét các hình thức kỷ luật khác nếu vi phạm nhiều lần trong vòng 3 tháng.
Nhân viên từ cấp quản lý (Phó phòng trở lên) sẽ không bị ảnh hưởng bởi Điều 10
10.3. Khen thưởng :
• Đi làm đầy đủ trong 1 tháng và không bị đi muộn, về sớm: Thưởng 0.5 ngày phép.
• Ngoài ra, cá nhân tuân thủ tốt giờ giấc làm việc theo quy định liên tục trong vòng 6 tháng đầu năm/cuối năm liên tục sẽ được thưởng 02 ngày nghỉ phép, trong vòng 1 năm liên tục sẽ được thưởng 05 ngày nghỉ phép (bao gồm 02 ngày nghỉ của 6 tháng đầu năm).
Điều 3 [Thời gian làm việc ngoài giờ]
1. Làm thêm ngoài giờ phải có sự sắp xếp, đồng ý của cấp trên trực tiếp quản lý bộ phận.
2. Giờ làm thêm được tính theo quy định của luật lao động.
3. Tiền Giờ làm thêm ngày thường sẽ chỉ được tính từ sau 18h00, đồng thời Người lao động chỉ được tính giờ làm thêm khi đã làm đủ 8 tiếng trong ngày hôm đó.
Điều 4 [Ngày nghỉ ]
1. Thứ 7 và chủ nhật theo quy định của công ty
2. Những ngày nghỉ có lương được quy định như sau.
• Ngày nghỉ lễ theo luật định Việt Nam
• Nếu ngày nghỉ lễ trùng vào ngày nghỉ hằng tuần theo quy định, thì người lao động được nghỉ bù vào ngày kế tiếp
Điều 5 [Nghỉ phép]
1. Số ngày nghỉ phép năm đối với người lao động làm việc từ 1 năm trở lên là 12 ngày. Tổng số ngày nghỉ phép năm sẽ tăng theo thâm niên công tác (cứ 3 năm được nghỉ thêm 1 ngày). Khi xin nghỉ phải nộp đơn xin nghỉ cho Trưởng bộ phận trước 2 ngày. Nhân viên phải sử dụng số ngày nghỉ phép của năm cho đến hết tháng 3 năm kế tiếp.
2. Nhân viên người nước ngoài được nghỉ về nước 6 tháng 1 lần (số ngày nghỉ về nước là 7 ngày).
3. Người lao động Việt Nam có thể được sử dụng số ngày nghỉ phép năm để xin nghỉ phép tối đa 5,5 ngày liên tục.
4. Các kỳ nghỉ đặc biệt được nghỉ hưởng nguyên lương và không trừ ngày phép.
• Chỉ được Nghỉ phép để tổ chức cưới xin với những trường hợp sau:
- Kết hôn bản thân: 5 ngày
- Con đẻ, con nuôi kết hôn: 01 ngày
• Chỉ được Nghỉ tang lễ với những trường hợp sau: Bố, mẹ, vợ, chồng, con cái, anh chị em ruột: 03 ngày
Điều 6 [Nghỉ không lương]
Nghỉ ốm, nghỉ đột xuất: Trường hợp phải xin nghỉ ốm, nghỉ đột xuất người lao động phải được sự chấp thuận của cấp trên trực tiếp đồng thời thông báo cho phòng quản lý nhân sự trước giờ làm việc theo quy định ít nhất 30 phút của ngày làm việc đó (trừ một số lý do bất khả kháng diễn ra sát giờ đi làm). Ngày nghỉ sẽ bị trừ vào ngày nghỉ phép (Nếu còn) hoặc trừ 01 ngày lương.
1. Nghỉ thai sản:
1.1. Tổng số thời gian nghỉ thai sản của người lao động nữ bao gồm cả trước và sau khi sinh là 6 tháng . Khi chuẩn bị nghỉ thai sản người lao động phải làm đơn nộp cho Trưởng Bộ phận, Phòng nhân sự trước 2 tuần.
Công ty không thanh toán lương trong thời gian nghỉ thai sản này. Người lao động sẽ hưởng lương theo chế độ BHXH.
Tuy nhiên trong quá trình nghỉ thai sản mà người lao động có nguyện vọng đi làm trở lại thì công ty sẽ xem xét chấp thuận dựa trên quy định của pháp luật.
1.2.Trong thời gian mang thai từ tháng thứ 5 trở đi người lao động được nghỉ không hưởng lương 1 ngày/tháng để đi khám thai sản

CHƯƠNG 2: ĐÁNH MÃ DỰ ÁN, ĐÁNH MÃ TÀI LIỆU
Điều 1 [EMail công ty]
Các email sau đóng vai trò là địa chỉ trung tâm của từng công ty để tiếp nhận toàn bộ email gửi đến:
info@planadd.com: Hai công ty KPA và VPA cùng sử dụng mail này làm email chung của họ
info@add-group.net: Các công ty còn lại thuộc ADD Group sẽ dùng email này 
300@add-group.net: Mail này cho phòng kế toán sử dụng chung
Điều 2 [Gửi hồ sơ, công văn đi]
Sau khi nhận được sự đồng thuận của cấp trên, nhân viên sẽ gửi hồ sơ, công văn cho đối tác và mỗi công văn sẽ phải được ghi lại trong biểu mẫu: https://docs.google.com/a/planadd.com/spreadsheet/ccc?key=0Avq5HyYkeLftdDNZb1I1SGtFeGFUWVlyWW5uZXJYSnc#gid=0
Điều 3 [Tên công ty]
Sau đây là tên viết tắt của từng công ty
ADD 건설 GROUP - Công ty CP Tập đoàn Đầu tư và Xây dựng ADD: ADD; ㈜ 플랜애드 건축사 사무소/ Plan Add Architects Co., Ltd - Công ty Tư vấn Thiết kế PLAN ADD Hàn Quốc: KPA; Plan ADD Vietnam Co., Ltd - CÔNG TY TNHH PLAN ADD VIỆT NAM: VPA; ADD Construction Co., Ltd - Công ty TNHH Xây lắp ADD CON: ADC; ADD Global Co., Ltd - Công ty TNHH ADD Global: AGB; Art Secret Garden Co., Ltd - Công ty TNHH Art Secret Garden: ASG.
Điều 4 [Tên phòng ban]
Mỗi phòng ban chịu trách nhiệm quản lý và bảo quản tài liệu của mình. Vì thế cần phải đảm bảo đánh dấu rõ tài liệu thuộc về phòng ban nào để dễ dàng tìm kiếm và sử dụng. Sau đây là tên viết tắt của từng phòng ban: 
Hướng dẫn chung: 000; Kế hoạch, vận hành: 100; Hành chính nhân sự: 200; Tài chính kế toán: 300; Quản lý dự án (Dự toán, hồ sơ thầu,...): 500; Triển khai công việc (Thiết kế, xây dựng): 600 - 900.

Điều 5 [Thẻ folder cấp 1]
Mục đích: Folder cấp 1 phân loại tài liệu của các phòng ban và chỉ có Boss có quyền chỉnh sửa
Cách đặt tên: 100 đơn vị. Chi tiết công việc
Ví dụ: “000. Hướng dẫn chung” hoặc “300. Tài chính, kế toán”
Điều 6 [Thẻ folder cấp 2]
Mục đích: Folder cấp 2 ở trong folder cấp 1 để phân loại các hạng mục tài liệu của từng phòng ban và thuộc quyền chỉnh sửa của trưởng ban, trưởng bộ phận
Cách đặt tên: Tên công ty + số ngày - tháng - năm
Ví dụ: “010. Tiêu chí phân loại” hoặc “310. Kế hoạch tài chính”
Điều 7 [Thẻ folder cấp 3]
Mục đích: Folder cấp  3 ở trong folder cấp 2 để phân loại từng hạng mục chi tiết trong các hạng mục tài liệu của từng phòng ban và thuộc quyền chỉnh sửa của nhân viên sở hữu tài liệu.
Cách đặt tên: 1 đơn vị. Chi tiết công việc (tiêu đề tài liệu)
Ví dụ: “011. Phân loại nhân viên” hoặc “312. Kế hoạch năm 2024”
Điều 8 [Thẻ phân loại khác]
Chỉ sử dụng các thẻ phân loại trên và Không vượt quá cấp 3
Điều 9 [Thẻ phân loại các tài liệu cũ hoặc sẽ xóa]
Các tài liệu được lên lịch xóa sẽ có đuôi là ". DEL" và sẽ được xóa sau 3 năm
Các tài liệu tham khảo đã cũ thì sẽ có đuôi là ". CŨ"
Ví dụ: “007. Lịch Quy định. DEL” hoặc “252. Hợp đồng lao động. CŨ”
Điều 10 [Tiêu đề file tài liệu]
Cách đặt tên: Năm tháng ngày.Phiên bản.Thẻ phòng ban.Tiêu đề tài liệu. Số nhận dạng (A: Lưu hành nội bộ, B: Nhà thầu phụ, C: Gửi khách hàng)
Trong đó: 
- Phiên bản: Version thứ bao nhiêu của file
- Tiêu đề tài liệu: Có thể tùy ý đặt tên bất kỳ
- Số nhận dạng: Được chia làm 3 chữ A, B, C. Với:
+ A: Lưu hành nội bộ
+ B: Nhà thầu phụ
+ C: Gửi khách hàng
Khi đặt tên file, nhân viên cần ghi rõ số nhận dạng để đảm bảo gửi đúng tài liệu cho khách hàng/đối tác. 

Ví dụ 1: Tôi thuộc phòng nhân sự, tôi đang làm file báo cáo tình hình nhân sự năm 2025, tôi đặt tên file thế nào? 
Câu trả lời: Cách đặt tên: Năm tháng ngày.Phiên bản.Thẻ phòng ban.Tiêu đề tài liệu. Số nhận dạng (Trong đó A: Lưu hành nội bộ, B: Nhà thầu phụ, C: Gửi khách hàng; Phiên bản: Version thứ bao nhiêu của file) 
Giả sử đây là phiên bản đầu tiên, lập trong ngày hôm nay và để lưu hành nội bộ. Vì đây là phòng nhân sự nên thẻ phòng là 200.
Kết quả đặt tên là: 250107.V1.200.Báo cáo tình hình nhân sự năm 2025.A

Ví dụ 2: Tôi thuộc phòng kế toán, tôi đang làm file báo cáo năm 2025, tôi đặt tên file thế nào?
Câu trả lời: Cách đặt tên: Năm tháng ngày.Phiên bản.Thẻ phòng ban.Tiêu đề tài liệu. Số nhận dạng (Trong đó A: Lưu hành nội bộ, B: Nhà thầu phụ, C: Gửi khách hàng; Phiên bản: Version thứ bao nhiêu của file) 
Giả sử đây là phiên bản thứ 3, lập trong ngày hôm nay và để lưu hành nội bộ do phòng kế toán (300) làm
Kết quả đặt tên là: 250107.V3.300.Báo cáo năm 2025.A

Ví dụ 3: Tôi cần đặt tên file báo giá, tôi cần đặt như thế nào?
Câu trả lời: Cách đặt tên: Năm tháng ngày.Phiên bản.Thẻ phòng ban.Tiêu đề tài liệu. Số nhận dạng (Trong đó A: Lưu hành nội bộ, B: Nhà thầu phụ, C: Gửi khách hàng; Phiên bản: Version thứ bao nhiêu của file) 
Giả sử đây là phiên bản thứ 6, lập trong ngày hôm nay và để gửi cho khách hàng do phòng dự toán (500) làm
Kết quả đặt tên là: 250107.V6.500.Báo giá.C

Ví dụ 4: Tôi đang làm báo cáo lợi nhuận dự án essa, tôi đặt tên file thế nào?
Câu trả lời: Cách đặt tên: Năm tháng ngày.Phiên bản.Thẻ phòng ban.Tiêu đề tài liệu. Số nhận dạng (Trong đó A: Lưu hành nội bộ, B: Nhà thầu phụ, C: Gửi khách hàng; Phiên bản: Version thứ bao nhiêu của file) 
Giả sử đây là phiên bản thứ 2, lập trong ngày hôm nay và để gửi cho nhà thầu phụ do phòng dự toán (500) làm
Kết quả đặt tên là: 250107.V2.500.Báo cáo lợi nhuận dự án essa.B
Điều 11 [Cách đặt tên Folder cấp 1]
Cách đặt tên Folder cấp 1: Phân loại công ty. Phòng ban - Tiêu đề chi tiết (Lần lượt với ba thứ tiếng Anh - Hàn - Việt)
Ví dụ: ADD.200 - Labor contract - 노동 계약 - Hợp đồng lao động
Lưu ý: Khi chia sẻ tài liệu hãy chú ý đến những người nào có quyền chỉnh sửa để đảm bảo tính an toàn và bảo mật của tài liệu
Điều 12 [Số tài liệu]
Mục đích: Đặt tên số tài liệu trong công văn, văn bản một cách dễ nhớ và khoa học
Cách đặt tên: Tên công ty + số ngày - tháng - năm
Ví dụ: “KPA11-12-24” hoặc “ADD10-09-20”
Điều 13 [Số dự án]
Cách đặt tên: Thẻ công ty + Thẻ năm-Số sê-ri + Tên dự án. (Trong đó: Số sê-ri chỉ số thứ tự của dự án đó trong năm)
Ví dụ: “KPA11-01 Quận Yangpyeong Byeongsan APT” hay “VPA22-01 Khách sạn Ngọc Hà”

Ví dụ 1: Tôi thuộc công ty plan add việt nam, hôm nay tôi có dự án A, tôi phải đánh số dự án như thế nào? 
Câu trả lời: Cách đặt tên dự án: Thẻ công ty + Thẻ năm-Số sê-ri + Tên dự án. (Trong đó: Số sê-ri chỉ số thứ tự của dự án đó trong năm). 
Giả sử đây là dự án đầu tiên trong năm nay và vì bạn thuộc công ty plan add việt nam (VPA). 
Ta có kết quả: VPA25-01 A

Ví dụ 2: Tôi muốn đánh mã cho dự án mới tên là FLC quy nhơn
Câu trả lời: Cách đặt tên dự án: Thẻ công ty + Thẻ năm-Số sê-ri + Tên dự án. (Trong đó: Số sê-ri chỉ số thứ tự của dự án đó trong năm). 
Giả sử đây là dự án thứ 6 trong năm nay và bạn thuộc công ty ADD Group. 
Ta có kết quả: ADD25-06 FLC quy nhơn

Ví dụ 3: Tôi cần đánh mã dự án mới tên là: essa hitech (Tôi thuộc công ty ADD Global)
Câu trả lời: Cách đặt tên dự án: Thẻ công ty + Thẻ năm-Số sê-ri + Tên dự án. (Trong đó: Số sê-ri chỉ số thứ tự của dự án đó trong năm). 
Giả sử đây là dự án thứ 2 trong năm nay và bạn thuộc công ty ADD Global. 
Ta có kết quả: AGB25-02 essa hitech

Ví dụ 4: Tôi cần đánh mã dự án mới tên là: SOJO (Tôi thuộc công ty ADD Con)
Câu trả lời: Cách đặt tên dự án: Thẻ công ty + Thẻ năm-Số sê-ri + Tên dự án. (Trong đó: Số sê-ri chỉ số thứ tự của dự án đó trong năm). 
Giả sử đây là dự án thứ 8 trong năm nay và bạn thuộc công ty ADD Conl. 
Ta có kết quả: ADC25-08 SOJO
Điều 14 [Cách đánh dấu năm]
Cách đánh dấu năm khi đặt tên tài liệu: Chỉ sử dụng 2 con số cuối cùng của năm
Ví dụ: Năm 2023 sẽ được đánh dấu là 23. Năm 2009 sẽ được đánh dấu là 09

CHƯƠNG 3: CÁC ĐƯỜNG LINK, FORM MẪU CHUNG
Link dẫn đến các tài liệu, form mẫu,...

Form đăng ký sử dụng con dấu: https://docs.google.com/forms/d/e/1FAIpQLSe9MPArDxNWSVnxU-7RPKybCW1zf5hyzuuPw4lirCwqvBgMKw/viewform?pli=1  
Form đề nghị thanh toán online của ADD: https://docs.google.com/forms/d/e/1FAIpQLSdxe1Ys-EBR473wpqbr_0HIL4Wr0S4A9G6xE8sT-CZmT-gNoQ/viewform?pli=1 
Form đề nghị thanh toán online của VPA: https://docs.google.com/forms/d/e/1FAIpQLSe1RL2H8ETmaz2adT7PJMUdxMxkFjZiKDbfuEpnMIfbv_g0nw/viewform?pli=1 
Form đăng ký mua văn phòng phẩm: https://docs.google.com/spreadsheets/d/10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ/edit?usp=sharing 
Form đề nghị làm thêm giờ: https://docs.google.com/forms/d/e/1FAIpQLSfAo1y1wvJXqFjfBVdUAT5hUaPuH9BIdERLvYDjLImj9qmXwQ/viewform 
Schedule Form -  tiến độ công việc: https://docs.google.com/spreadsheets/d/1_Vs44xzlsuK-A0dB9wYuZo27GQ2ySQUwcWQgX6olr1Y/edit?usp=sharing 
Form báo cáo cuộc họp (Meeting report): https://docs.google.com/spreadsheets/d/1o8JoVz4wiad_t4Rd1jwKWzPmToDaqcOQs1HPJY4GFRc/edit?gid=923456535#gid=923456535 
Biên bản bàn giao hồ sơ: https://docs.google.com/document/d/1VKoHv-cZWJ5CEalfpicM9kEZzLeDjwc-_5vj41a0L6Q/edit?tab=t.0 
Bảng báo giá thiết kế: https://docs.google.com/spreadsheets/d/14FV5b7pdufZQdDkqgbD64tlsiHA2t9W22WulsGjjCwQ/edit?usp=sharing 
Báo cáo giám sát đầu tư: https://docs.google.com/document/d/1waep2V9LD_2JUa2E4EhRm0Qz7-3yo_RWd7ddlwQxBjQ/edit?tab=t.0 
Biên nhận tiền: https://docs.google.com/spreadsheets/d/1klLDvMQeAbTGzb385kCfZPz2E003ATjBE7A97dTRWw0/edit?gid=444784611#gid=444784611 
Đề nghị hoàn ứng: https://docs.google.com/spreadsheets/d/1czGIu08W4R_9ig1PdZMGDJA-thQKLIWZjgxwGuaAA4k/edit?gid=980403237#gid=980403237 
Đề nghị tạm ứng: https://docs.google.com/spreadsheets/d/1R4Rgj8W5ghKMfK3E4KNdgnB1dpvAZBys80u_qAQ1KW0/edit?usp=sharing 
Đơn xin nghỉ phép: https://docs.google.com/document/d/1fm_PRf0zIFyYBhYVPyO10ceEPCxV8AWcACDdZiJOgwk/edit?usp=sharing
Đơn xin nghỉ việc: https://docs.google.com/document/d/1_rshuPSWNxTh18FRAJQ6WNIPPU2bMVc8al_-Aziw8XI/edit?usp=sharing    
Đơn nghỉ thai sản: https://docs.google.com/document/d/1komIN7xQH4ZzrzAj58nbHEDfHsbtMl9ACUohZTPcgOA/edit?usp=sharing  
Mẫu hồ sơ nhân viên: https://docs.google.com/spreadsheets/d/1oyKTdbTNqeba_juvskDGDueucPco3OQdsPQ4nnav9DM/edit?gid=374638353#gid=374638353 
Thỏa thuận chấm dứt hợp đồng: https://docs.google.com/spreadsheets/d/1sFLPT5bRvdLpc3spd2fcYKw5sESMxdmQm_HacRVYT78/edit?gid=1222850533#gid=1222850533 
Đăng ký đổi khung giờ làm việc: https://docs.google.com/spreadsheets/d/1Tg3tU2ILUvTSt7S9RJaPLhipOnXkO0xqEimbiEb9N30/edit?gid=2026000455#gid=2026000455 
Biên bản vụ việc: https://docs.google.com/document/d/1w8szPvWJVqSGW0ERshLma7n9FKCDjEGnUbHxDwqGRQE/edit?tab=t.0 
Biên bản bàn giao công việc: https://docs.google.com/spreadsheets/d/1SdZUI8k4keP1SatVjKeQVelTz5vbO7iGJCnUx0_Yo7U/edit?gid=1801370334#gid=1801370334 
Thông báo chấm dứt Hợp đồng lao động: https://docs.google.com/document/d/1wUUsxsRiPRL8-cj1Yz5FZv23WXylJ0Doux3nXqxUCGI/edit?tab=t.0 
Quyết định chấm dứt Hợp đồng lao động: https://docs.google.com/document/d/15wAmSmijd99MshV8rfdd0dedcBqCk9oTVXDn5hl1TSQ/edit?tab=t.0 
Biên bản bàn giao tài sản: https://docs.google.com/spreadsheets/d/1CIUmmnq7u9Ozluyv1rG3gyB2y5X7mB2uEJoe0DvzmLQ/edit?gid=707200935#gid=707200935 
Giấy giới thiệu: https://docs.google.com/document/d/0Bw_u1f220kn1WEdfTUk3NDNEblU/edit?resourcekey=0-y0DtHIX_Ij4Lo9ssEzvksw 
Giấy ủy quyền: https://docs.google.com/document/d/1_lYrwtr7oLxMt4eDD7cfJDuoCSWO2SoBu2Rqt9Reses/edit?tab=t.0 
Mẫu công văn: https://docs.google.com/document/d/1yPln3KUOJeWJ_8rlLWudChQxF5bPqSW6lTIMZX6iFDQ/edit?tab=t.0 
Biên bản giao nhận hồ sơ: https://docs.google.com/spreadsheets/d/1bB5ub5kA37w2qR40RI2tFfgMl01YZYuf9jgYDfb2yVI/edit?gid=0#gid=0 
Form đăng ký mượn tài liệu, hồ sơ: https://forms.gle/NA8HX2ARpWuAQFrS7 

CHƯƠNG 4: MỤC ĐÍCH VÀ KHÁI NIỆM CƠ BẢN
Điều 15 [Mục đích]
Mục đích của quy định nhân sự này là nhằm xây dựng một hệ thống quản lý nhân sự phù hợp trên cơ sở thiết lập những điều khoản cơ bản liên quan đến nhân sự Công ty.
1.Nhân viên làm việc trên hệ thống google của công ty. Luôn đảm bảo dữ liệu google được chia sẻ đúng cách.
2. Nhân viên phải được đào tạo về nội quy, quy định của công ty.
3. Nhân viên sử dụng lịch Google Calendar để lập kế hoạch và báo cáo công việc hàng ngày để cấp trên quản lý
4. Nhân viên phải tham gia vào các buổi đào tạo nội bộ do cấp trên, công ty tổ chức và phải hoàn thành các bài kiểm tra sau mỗi buổi đào tạo.
5. Nhân viên phải sử dụng Google chat để trao đổi các công việc nội bộ. Chỉ được phép sử dụng zalo, viber,... khi liên hệ với khách hàng, đối tác bên ngoài.
6. Nhân viên phải nắm được sơ đồ của công ty, trách nhiệm và quyền hạn của từng vị trí nhân sự trong công ty để tương tác.
7. Công ty hoạt động tuân thủ trên luật Lao động Việt Nam và văn hoá làm việc của Việt nam và Hàn Quốc.
8. Không được có những hành động gây ảnh hưởng đến lợi ích công ty đồng thời không được làm rò rỉ các thông tin của công ty cho người ngoài dù đang làm việc hay đã nghỉ làm.
9. Thực hiện công việc được giao một cách trung thực, có trách nhiệm và thực hiện việc báo cáo kịp thời cho cấp trên.
10. Nghiêm cấm lợi dụng công ty thực hiện các hành vi kinh doanh để kiếm lợi hoặc thực hiện các công việc khác trong công ty khi chưa có sự đồng ý của cấp trên.
11. Không được nhận quà biếu, tặng hối lộ trong quá trình giao dịch, ngoại giao.
12. Không được ra ngoài làm việc riêng, xem phim hoặc chơi game trong giờ làm việc
13. Trước khi ra về phải dọn dẹp chỗ ngồi ngăn nắp, kiểm tra hệ thống an ninh, tắt bóng đèn, thiết bị.
Nếu nhân viên vi phạm các điều khoản trong nguyên tắc lao động trên thì sẽ bị cấp trên xử lý kỷ luật.
14. Khi tạo folder dự án hoặc tạo sự kiện lịch liên quan đến một dự án phải đảm bảo sử dụng đúng mã dự án
CHỨC NĂNG CỦA CÁC PHÒNG BAN 
Phòng 000: Hướng dẫn về các quy định về Google Drive, Mail, Calendar, Site & Blogger, Hangout, Chrome & Bookmark và các ứng dụng khác có trong Google. 
Phòng 100: Lập kế hoạch về tổ chức sự kiện, Quản lý tiền mặt và lương, bán hàng, Quản lý nhân sự công ty, Intranet, Đánh giá và Hợp tác. 
Phòng 200 (Hành chính nhân sự) - Quản lý văn bản tài liệu; - Quản lý tài sản;
- Quản lý nhân sự: Lưu trữ, cập nhật thông tin, xử lý các thủ tục liên quan đến hồ sơ nhân viên. - Quản lý con dấu; - Hỗ trợ kỹ thuật, làm các công việc thay IT; - Các công việc liên quan đến Pháp lý, pháp chế, Dịch vụ văn phòng. 
Phòng 300 (Tài chính kế toán) - Lập kế hoạch Tài chính; - Quản lý Tài liệu tài chính; - Quản lý hợp đồng và các khoản thanh toán: Quản lý toàn bộ chứng từ, hồ sơ kế toán mảng thi công công trình. Quản lý hồ sơ phục vụ đấu thầu, ký hợp đồng và quản lý chất lượng thi công xuyên suốt trong quá trình thực hiện các công trình; - Kế toán nội bộ: Phối hợp cùng các bộ phận thống kê tiến độ, kết quả thi công cho từng công trình và tổng hợp kết quả sản lượng toàn chi nhánh định kỳ.
Quản lý, theo dõi xuất nhập nguyên vật liệu, sử dụng chi phí phục vụ thi công cho từng công trình; - Kế toán thuế: Quản lý hồ sơ kế toán thuế. Lập báo cáo thuế gửi cơ quan thuế định kỳ và thực hiện quyết toán thuế theo quy định của nhà nước; - Quản lý nợ; - Đối tác tài chính và Giáo dục tài chính. Phòng 400 (Marketing) Nhiệm vụ: Lập kế hoạch Marketing; Làm Brochure công ty; Soạn tài liệu Marketing nội bộ; Quản lý Bộ nhận diện thương hiệu (CI) - Logo (BI); Chăm sóc đối tác; Chăm sóc khách hàng; Tổ chức sự kiện. Phòng 500 (Dự toán) - Lập các hợp đồng thanh toán, báo giá: Lập Hợp đồng, hồ sơ thanh toán với Chủ đầu tư và thầu phụ; - Quản lý các văn bản về Hợp đồng thanh toán: Thực hiện hồ sơ thanh, quyết toán với Chủ đầu tư và với thầu phụ, tổ đội thi công;
- Quản lý Báo giá: Lập dự toán chi tiết theo bản vẽ thiết kế, Tính báo giá thiết kế; - Quản lý Hồ sơ Năng lực kế hoạch của ADD Group: Lập hồ sơ dự thầu (Hồ sơ năng lực, giá trị dự thầu); - Quản lý tài liệu mời thầu: Tìm nhà thầu phụ, tập hợp báo giá từ thầu phụ; - Quản lý Pháp lý dự án: Kiểm soát khối lượng, chất lượng công trình;
Điều 16 [Phạm vi áp dụng]
Những điều khoản không hoặc chưa được nêu rõ trong quy định này sẽ được tuân theo Bộ luật lao động của nước Cộng hòa xã hội chủ nghĩa Việt Nam.
Đường link để đọc toàn bộ nội quy công ty: https://docs.google.com/spreadsheets/d/1r8EE--qcu1VPUNn-0Ictwy1QCPedaMhU6M0USBKTiAo/edit?gid=1657885989#gid=1657885989

CHƯƠNG 5: HỢP ĐỒNG LAO ĐỘNG
Điều 17 [Quy định Hợp đồng Lao động]
1. Khi tuyển dụng người lao động mới, công ty sẽ có thời gian thử việc 02 tháng để đánh giá năng lực và sự phù hợp với công việc cần trình độ cao đẳng trở lên. Tuy nhiên trong thời gian thử việc công ty và người lao động có quyền chấm dứt hợp đồng trong thời gian thử việc nếu công việc/ nhân sự thử việc không phù hợp.
2. Thời gian thử việc cũng được tính vào thâm niên công tác sau này, mức lương thử việc là 85% lương chính thức.
3. Khi chính thức được tuyển dụng người lao động sẽ được ký Hợp đồng lao động thời hạn 01 năm theo mẫu của Công ty
4. Thời hạn hợp đồng lao động được tính trên cơ sở nguyên tắc là Hợp đồng lao động 1 năm. Sau khi chấm dứt hợp đồng lao động thời hạn 1 năm lần thứ 2 Công ty sẽ tiến hành giao kết Hợp đồng lao động không xác định thời hạn với người lao động.

CHƯƠNG 6: CHẤM DỨT/ĐƠN PHƯƠNG CHẤM DỨT HỢP ĐỒNG LAO ĐỘNG
Điều 18 [Chấm dứt Hợp đồng]
Người lao động bị xem xét cho nghỉ việc trong các trường hợp sau:
1. Trường hợp Công ty có tuyên bố phá sản, giải thể
2. Trường hợp thời hạn hợp đồng lao động hết hạn mà không được ký tiếp. Công ty sẽ có thông báo không tái ký Hợp đồng lao động trước 30 ngày đối với hợp đồng lao động có thời hạn 1 năm, 45 ngày với hợp đồng không xác định thời hạn.
3. Hai bên thỏa thuận tự nguyện chấm dứt hợp đồng lao động.
4. Người lao động bị kết án phạt tù nhưng không được hưởng án treo hoặc không thuộc trường hợp được trả tự do theo quy định tại khoản 5 Điều 328 của Bộ luật Tố tụng hình sự, tử hình hoặc bị cấm làm công việc ghi trong hợp đồng lao động theo bản án, quyết định của Tòa án đã có hiệu lực pháp luật.
5. Người lao động là người nước ngoài làm việc tại Việt Nam bị trục xuất theo bản án, quyết định của Tòa án đã có hiệu lực pháp luật, quyết định của cơ quan nhà nước có thẩm quyền.
6. Người lao động chết, bị Tòa án tuyên bố mất năng lực hành vi dân sự, mất tích hoặc đã chết.
7. Người lao động bị xử lý kỷ luật sa thải.
8. Người lao động đơn phương chấm dứt hợp đồng lao động theo quy định tại Bộ luật Lao động
9. Công ty đơn phương chấm dứt hợp đồng lao động theo quy định tại Bộ luật lao động
10. Công ty cho người lao động thôi việc trong trường hợp thay đổi cơ cấu, công nghệ hoặc vì lý do kinh tế hoặc khi công ty chia, tách, hợp nhất, sáp nhập, bán, cho thuê, chuyển đổi loại hình doanh nghiệp.
Điều 19 [Đơn phương chấm dứt Hợp đồng lao động của công ty]
Công ty được quyền đơn phương chấm dứt hợp đồng lao động trong các trường hợp dưới đây:
1. Trường hợp nghỉ quá 30 ngày liên tục vì lý do bệnh tật cá nhân (bao gồm cả ngày phép)
2. Người lao động thường xuyên không hoàn thành công việc theo hợp đồng lao động theo tiêu chí đánh giá mức độ hoàn thành công việc trong quy chế của người sử dụng lao động (áp theo đánh giá nhân sự của công ty).
3.Do thiên tai, hỏa hoạn, dịch bệnh nguy hiểm, địch họa hoặc di dời, thu hẹp sản xuất, kinh doanh theo yêu cầu của cơ quan nhà nước có thẩm quyền mà Công ty đã tìm mọi biện pháp khắc phục nhưng vẫn buộc phải giảm chỗ làm việc.
4. Người lao động không có mặt tại nơi làm việc sau thời hạn tạm hoãn hợp đồng lao động
5. Người lao động đủ tuổi nghỉ hưu, trừ trường hợp có thỏa thuận khác.
6. Người lao động tự ý bỏ việc mà không có lý do chính đáng (theo Điều 125 Bộ luật Lao động 2019) từ 05 ngày làm việc liên tục trở lên.
7. Người lao động cung cấp thông tin không trung thực khi giao kết hợp đồng lao động làm ảnh hưởng đến việc tuyển dụng người lao động.
8. Công ty sẽ thông báo cho người lao động trước 30 ngày (với hợp đồng lao động có thời hạn) và 45 ngày (với hợp đồng không xác định thời hạn) khi đơn phương chấm dứt hợp đồng lao động.

Điều 20 [Đơn phương chấm dứt Hợp đồng lao động của người lao động]
1. Trường hợp người lao động muốn nghỉ việc trước thời hạn hợp đồng thì phải thông báo ít nhất trước 30 ngày (với hợp đồng lao động có thời hạn) và trước 45 ngày (với hợp đồng lao động không thời hạn) và đệ trình đơn xin thôi việc để xin phê duyệt của cấp trên. Nếu Ban lãnh đạo công ty và nhân viên đồng thuận thì có thể xét duyệt nghỉ sớm hơn quy định. Nếu hai bên chưa đồng thuận mà nhân viên tự ý nghỉ trước thời hạn thì sẽ phải bồi thường cho công ty nửa tháng tiền lương theo Hợp đồng lao động và một khoản tiền tương ứng với tiền lương theo hợp đồng lao động những ngày không báo trước.
2. Người lao động có quyền đơn phương chấm dứt hợp đồng lao động không cần báo trước thời gian quy định, nhưng vẫn phải thực hiện việc thông báo nghỉ việc cho công ty trong trường hợp sau đây:
a) Không được bố trí theo đúng công việc, địa điểm làm việc hoặc không được bảo đảm điều kiện làm việc theo thỏa thuận, trừ trường hợp công ty chuyển người lao động làm công việc khác so với Hợp đồng quy định tại Điều 29 của Bộ luật lao động.
b) Không được trả đủ lương hoặc trả lương không đúng thời hạn, trừ trường hợp bất khả kháng quy định tại khoản 4 Điều 97 của Bộ luật lao động.
c) Bị người sử dụng lao động ngược đãi, đánh đập hoặc có lời nói, hành vi nhục mạ, hành vi làm ảnh hưởng đến sức khỏe, nhân phẩm, danh dự, bị cưỡng bức lao động.
d) Bị quấy rối tình dục tại nơi làm việc.
e) Lao động nữ mang thai phải nghỉ việc theo quy định tại khoản 1 Điều 138 của Bộ luật lao động.
f) Đủ tuổi nghỉ hưu theo quy định tại Điều 169 của Bộ luật lao động, trừ trường hợp các bên có thỏa thuận khác.
g) Công ty cung cấp thông tin không trung thực theo quy định tại khoản 1 Điều 16 của Bộ luật lao động làm ảnh hưởng đến việc thực hiện hợp đồng lao động của người lao động.


CHƯƠNG 7: TIỀN LƯƠNG
Điều 21 [Tiền lương]
Tiền lương và phương thức thanh toán được điều chỉnh theo hệ số thang bảng lương và được quy chế hoá nhằm đảm bảo các điều kiện cơ bản so với mặt bằng chung. Phòng kế toán sẽ tính và thanh toán lương trên cơ sở hệ số của thang bảng lương.
Điều 22 [ Quản lý chứng chỉ, bằng cấp]
Khi người lao động nộp đầy đủ các chứng chỉ ngoại ngữ hay các chứng chỉ khác mà được công ty chấp nhận cho phòng nhân sự thì phòng kế toán sẽ tính toán theo hệ số để xem xét nâng lương cho người lao động.
Những chứng chỉ được công ty ghi nhận như sau:
1. Ngoại ngữ(tiếng Anh): TOEIC (750 điểm), IELTS (6.0 điểm trở lên), TOEFL (500 điểm), Tiếng Hàn: TOPIK (cấp 3 trở lên)
2. Bằng cấp tốt nghiệp trình độ cao hơn. (Thạc sỹ, Tiến sĩ)
Điều 23 [Trợ cấp làm thêm giờ]
Trước khi bắt đầu mỗi dự án, Trưởng bộ phận có trách nhiệm thông báo rõ ràng cho các thành viên trong nhóm, cấp quản lý và phòng hành chính kế toán về tổng quỹ thời gian dự kiến tăng ca cần thiết để hoàn thành dự án.
Nhân viên phải đăng ký làm thêm giờ với quản lý bộ phận từ trước và nhận được sự đồng ý thì mới làm thêm giờ theo quy định tại Điều 8. Trong trường hợp có giờ làm thêm, nhân viên phải khai báo lại cho Trưởng các bộ phận và được Trưởng các bộ phận xác nhận vào phiếu làm thêm giờ và phải nộp phiếu xác nhận làm thêm cho phòng kế toán trước ngày 1 hàng tháng. Phụ cấp lương làm thêm giờ được tính như quy định dưới đây hoặc được bù lại bằng ngày nghỉ nếu nhân viên có nhu cầu nghỉ bù.
1. Ngày thường (150% lương)
2. Ngày nghỉ (200% lương)
3. Ngày nghỉ lễ của quốc gia (300% lương)
16.1. Người lao động được nghỉ làm việc, hưởng nguyên lương trong những ngày nghỉ lễ của quốc gia sau đây; nếu đi làm sẽ được hưởng 300% lương vào những ngày này:
Tết Dương lịch: 01 ngày (ngày 01 tháng 01 dương lịch); Tết Âm lịch: 05 ngày; Ngày Chiến thắng: 01 ngày (ngày 30 tháng 4 dương lịch); Ngày Quốc tế lao động: 01 ngày (ngày 01 tháng 5 dương lịch);  Quốc khánh: 02 ngày (ngày 02 tháng 9 dương lịch và 01 ngày liền kề trước hoặc sau); Ngày Giỗ Tổ Hùng Vương: 01 ngày (ngày 10 tháng 3 âm lịch).

Nhân viên được hỗ trợ phụ cấp 40.000 VND/người tiền ăn ca cho mỗi lần tăng ca 3 tiếng trở lên.
Trợ cấp làm thêm giờ không áp dụng cho cấp quản lý.
Link đăng ký làm thêm giờ tại đây: https://docs.google.com/forms/d/e/1FAIpQLSfAo1y1wvJXqFjfBVdUAT5hUaPuH9BIdERLvYDjLImj9qmXwQ/viewform

CHƯƠNG 8 - CÔNG TÁC
Điều 24 [Cử đi công tác và chế độ công tác phí]
Khi cần đi công tác vì lí do công việc thì phải có xác nhận của Giám đốc hoặc Quản lý trực tiếp.
1. Chi phí di chuyển:
- Phòng HCNS sẽ đặt trước phương tiện đi lại (máy bay, tàu hỏa,...) cho nhân viên khi đi công tác
- Vé máy bay sẽ do phòng HCNS đặt trước. Hạng vé Economy (trừ khi có yêu cầu khác của Giám đốc).
- Chi phí di chuyển từ văn phòng ra sân bay và ngược lại sẽ được thanh toán (theo hóa đơn, chứng từ) với định mức:
- Dolphin Plaza - Nội Bài: tối đa 350,000đ/ lần
- Nội bài - Dolphin Plaza: tối đa 400,000đ/ lần
- Chi phí di chuyển tại khu vực công tác sẽ được chi trả theo thực tế và phải có hóa đơn, chứng từ để được thanh toán.
2. Tiền bồi dưỡng công tác phí ngoại tỉnh được tính như sau:
- Nhân viên đi công tác qua đêm (sau 10h đêm) sẽ được trả: 300,000đ/ ngày/ người
- Nhân viên đi công tác công tác trong ngày sẽ được trả:: 100,000đ/ngày/ người (full 8h)
- Khi đi công tác sẽ không được tính phí tăng ca
Công ty bồi dưỡng, hỗ trợ chi phí bao gồm chi phí: ăn uống, liên lạc , … cho cán bộ nhân viên mà không yêu cầu phải có hóa đơn, chứng từ.
3. Chi phí lưu trú ngoại tỉnh qua đêm:
- Việc đặt phòng sẽ do phòng HCNS thực hiện, không quá 2 người/ phòng.
- Đặt phòng thỏa mãn điều kiện: Chi phí tối đa 700,000đ/phòng/đêm (trừ khi có yêu cầu khác của Giám đốc).
4. Chi phí tiếp khách và hỗ trợ công việc:
- Chi phí phục vụ tiếp khách, hỗ trợ công việc: Tối đa không quá 3,000,000đ/ đợt công tác.
- Công ty sẽ thanh toán dựa trên hóa đơn, chứng từ hợp lệ.
5. Nếu đi công tác nước ngoài: Chi phí hỗ trợ công việc là 15,000,0000 VNĐ

CHƯƠNG 9 - KHEN THƯỞNG VÀ PHẠT
3 Bonus/ Penalty tương đương với 1 ngày lương và sẽ được tính vào các khoản tiền thưởng (Thưởng tháng 14; Thưởng đột xuất; ...) theo quyết định cụ thể của Tổng Giám Đốc.
Điều 25 [Thưởng tháng lương thứ 13]
Hàng năm công ty sẽ thưởng tháng lương thứ 13 cho CBNV dựa trên đánh giá lịch làm việc, đánh giá đào tạo và đánh giá nhân sự cuối năm. Tổng điểm cho 03 mục đánh giá dưới đây là 120 điểm, tối thiểu 80 điểm, tương đương với CNBV có thể được hưởng mức thưởng tháng 13 từ 80% đến 120% lương trung bình của năm dựa trên các mục đánh giá chi tiết dưới đây:
1. Đánh giá lịch cá nhân
Trưởng bộ phận phải thường xuyên nhắc nhở nhân viên đăng lịch trên Calendar và kiểm soát giao việc phù hợp. Trưởng bộ phận sẽ đánh giá việc thực hiện công việc báo cáo trên lịch của nhân viên bằng cách đột xuất kiểm tra, kiểm tra định kỳ… và chấm điểm. Tối đa số điểm của mục đánh giá lịch là 30 điểm/ năm.
2. Đánh giá giáo dục
Sau mỗi khoá đào tạo, các thành viên tham gia tiến hành các bài test kết quả buổi đào tạo. Tối đa số điểm mục đánh giá giáo dục là 40 điểm.
3. Đánh giá nhân sự giữa các nhân viên với nhau
Mỗi năm nhân sự sẽ thực hiện đánh giá chéo các nhân sự khác trong công ty. Số điểm tối đa cho mục đánh giá nhân sự này là 50 điểm. (Theo thứ tự xếp hạng: 5%= 50 điểm; 15%= 48 điểm; 60%= 45 điểm; 15%= 42 điểm; 5%= 40 điểm)
Điều 26 [Thưởng tháng lương thứ 14]
Tùy tình hình kinh doanh của năm, Giám đốc sẽ quyết định việc thưởng tháng lương thứ 14.
Mức thưởng dựa trên đánh giá của Giám đốc và các cấp quản lý, trưởng nhóm theo thực tế hiệu quả công việc hàng ngày của các nhân viên.
Điều 27 [Thưởng dự án]
1. Chỉ áp dụng đối với nhân viên đã giới thiệu dự án cho công ty.
2. Tuỳ từng dự án, Giám đốc sẽ quyết định mức thưởng.
3. Người nhận thưởng có nghĩa vụ đóng thuế TNCN theo quy định của nhà nước.
Điều 28 [Thưởng đánh giá khác]
Giám đốc có thể trao 1 hoặc nhiều giải đặc biệt cho những cá nhân/ tập thể xuất sắc dựa trên đánh giá riêng của Giám đốc.
Điều 29 [Thưởng Lễ, Tết]
1. Thưởng tết âm lịch (tháng lương 13): Căn cứ trên thời gian thực tế làm việc và kết quả đánh giá theo mục I Chương 7 tại quy định này
1.1. Dưới 1 năm công tác: thưởng theo tỷ lệ số tháng làm việc/năm nhân với lương thực nhận và tỷ lệ nhận thưởng.
1.2. Từ 1 năm trở lên: 01 tháng lương thực nhận * tỷ lệ thưởng theo đánh giá nhân sự.
Căn cứ vào lợi nhuận mà công ty thu được, ban lãnh đạo sẽ quyết định có thực hiện việc thưởng tết âm lịch hay không. Người nhận thưởng phải có trách nhiệm đóng thuế TNCN theo quy định của nhà nước.
2. Thưởng tết dương lịch:( được tính là ngày đầu tiên của năm: 01/01)
• Thực tập/Thử việc: 300.000 VNĐ
• Dưới 1 năm công tác: 500.000 VNĐ
• Trên 1 năm công tác: 700.000 VNĐ
3. Ngày Quốc tế lao động 1/5, ngày Quốc khánh 2/9, Tết trung thu:
• Thực tập/Thử việc: 200.000 VNĐ
• Dưới 1 năm công tác: 300.000 VNĐ
• Trên 1 năm công tác: 500.000 VNĐ
4. Ngày 01/06: Tặng quà cho các cháu (công dân Việt Nam tối đa 16 tuổi) là con của nhân viên trong công ty, phần quà tương đương 200.000 VNĐ/ cháu.
Điều 20 [Tiền mừng, Tiền hiếu]
1. Tiền hiếu:
1.1. Bố mẹ (chồng/ vợ), con cái: 2,000,000 VND
1.2. Ông bà ( nội/ ngoại): 1,000,000 VND
2. Tiền mừng:
2.1. Kết hôn : 2,000,000 VND
2.2. Sinh nhật : ( quà bánh, hoa..)
2.3. Sinh con: 1.000.000 VNĐ
3. Tiền thăm hỏi người ốm đau, tai nạn, dịch bệnh phải điều trị tại bệnh viện (nội, ngoại trú):
3.1. Nhân viên trong công ty: 2,000,000 VNĐ
3.2. Người nhà nhân viên (Vợ/chồng, bố, mẹ, con cái, anh chị em ruột): 1.000.000 VNĐ
Điều 31 [Work shop]
Là buổi làm việc trao đổi kinh nghiệm.
Tùy tình hình công việc, công ty sẽ tổ chức sinh hoạt Workshop. Trưởng các bộ phận sẽ phụ trách công tác này. Mục đích của Workshop là nhằm nâng cao mối quan hệ hữu nghị, giao lưu, chia sẻ kiến thức, văn hoá giữa các nhân viên.
Điều 32 [Nghỉ dã ngoại]
Để nâng cao tinh thần, tăng cường hiệu quả làm việc hàng năm Công ty tổ chức cho người lao động đi nghỉ dã ngoại 2 lần trong khoảng thời gian từ tháng 1 đến tháng 6 và khoảng từ tháng 7 đến tháng 12.
Có sự phê duyệt của giám đốc và đại diện pháp luật công ty dựa trên tình hình doanh thu của công ty.
Điều 33 [Chế độ khác hỗ trợ công việc]
1. Trợ cấp chi phí điện thoại tính vào thu nhập tuỳ từng vị trí công việc.
2. Hỗ trợ 40.000 VNĐ cho bữa trưa với nhân viên, thực tập sinh tại văn phòng, 30.000 VNĐ cho nhân viên công trường ngoài Hà Nội. Vị trí trưởng nhóm trở lên gộp vào mức thu nhập.
3. Sử dụng taxi: Ưu tiên cấp quản lý sử dụng phương tiện taxi khi xe công ty bận. Ngoài ra nhân viên có thể sử dụng taxi trong trường hợp cần thiết và được cấp trên cho phép.
4. Công ty hỗ trợ tiền xăng xe cho nhân viên ra ngoài vì công việc bằng xe máy là: 3.000 VNĐ/1 km
5. Công ty hỗ trợ tiền xăng xe cho nhân viên ra ngoài vì công việc bằng xe ô tô cá nhân (khi được sự đồng ý của Giám Đốc) là: 6.000 VNĐ/1 km
Điều 34 [Chế độ bảo hiểm]
Bắt đầu từ tháng 1 năm 2017, mức lương đóng bảo hiểm cho nhân viên tối đa là 70% mức lương ký Hợp đồng chính thức.
Trong trường hợp nhân viên có quyết định điều chỉnh mức lương, thì mức lương đóng bảo hiểm sẽ không thay đổi ngay, ban lãnh đạo cùng phòng Hành chính tổng hợp sẽ thực hiện thay đổi mức lương đóng Bảo hiểm 2 năm 1 lần cho toàn thể nhân viên cho phù hợp tình hình nhân sự hàng năm.

CHƯƠNG 10: VI PHẠM KỶ LUẬT LAO ĐỘNG, XỬ LÝ KỶ LUẬT LAO ĐỘNG VÀ TRÁCH NHIỆM VẬT CHẤT
Điều 35 [Các hành vi vi phạm kỷ luật]
Tất cả các hành vi không chấp hành đúng các điều khoản quy định trong Nội quy lao động cũng như các Quy định khác của Công ty hoặc vi phạm pháp luật lao động đều được coi là hành vi vi phạm kỷ luật lao động và phải chịu các hình thức kỷ luật .
Điều 36 [Các hình thức xử lý kỷ luật lao động]
Khi thực hiện các hành vi vi phạm kỷ luật lao động dưới đây, tùy theo mức độ vi phạm, người lao động bị xử lý một trong những hình thức kỷ luật dưới đây
1. Khiển trách
2. Kéo dài thời hạn xem xét tăng lương không quá 6 tháng
3. Cách chức
4. Sa thải
Điều 37 [Khiển trách]
Áp dụng khi người lao động vi phạm các hành vi sau đây:
1. Nghỉ việc từ 01 đến 02 ngày không xin phép trong 01 tháng làm việc.
2. Chơi trò chơi trong máy vi tính trong giờ làm việc, hoặc bị phát hiện có lưu trữ, cài đặt trò chơi điện tử trên máy vi tính được giao trách nhiệm quản lý.
3. Ngủ trong giờ làm việc
4. Không tuân thủ các nguyên tắc sử dụng máy móc, thiết bị của Công ty
5. Không chấp hành các quy định của Công ty.
Điều 38 [Kéo dài thời hạn xem xét nâng lương không quá 6 tháng hoặc cách chức ]
Áp dụng khi người lao động vi phạm các hành vi sau đây:
Trong thời gian 3 tháng kể từ ngày bị khiển trách bằng văn bản mà người lao động vẫn tiếp tục tái phạm.
Điều 39 [Sa thải ]
Áp dụng sa thải khi người lao động vi phạm các hành vi sau:
1. Người lao động có hành vi trộm cắp, tham ô, đánh bạc, cố ý gây thương tích, sử dụng ma túy trong phạm vi nơi làm việc, tiết lộ bí mật kinh doanh, bí mật công nghệ, có hành vi gây thiệt hại nghiêm trọng hoặc đe dọa gây thiệt hại đặc biệt nghiêm trọng về tài sản, lợi ích của người sử dụng lao động hoặc quấy rối tình dục tại nơi làm việc được quy định trong nội quy lao động.
2. Người lao động bị xử lý kỷ luật kéo dài thời hạn xem xét nâng lương hoặc cách chức mà tái phạm trong thời gian chưa xóa kỷ luật.
3. Người lao động tự ý bỏ việc 05 ngày cộng dồn trong thời hạn 30 ngày hoặc 20 ngày làm việc cộng dồn trong thời hạn 365 ngày kể từ ngày đầu tiên tự ý bỏ việc mà không có lý do chính đáng.

CHƯƠNG 11 [QUY TRÌNH MUA HÀNG - THANH TOÁN]
1. Quy trình mua hàng - Thanh toán
Ảnh quy trình mua hàng - thanh toán: https://drive.google.com/file/d/1E-8j5b583n5aXD-FaHRckTGAzmajRbp9/view?usp=drive_link 
Bước 1: Nếu bạn có nhu cầu mua hàng cần thiết nào, đầu tiên hãy đề xuất ý kiến sơ bộ với trưởng bộ phận. (Thông thường nếu món hàng là đồ văn phòng phẩm thì bạn chỉ cần đăng ký với phòng 200)
Bước 2: Sau khi ý kiến đưa ra và được duyệt, người đề xuất sẽ tiến hành lập báo giá. Nếu giá trị đơn hàng trên 1.000.000 đồng thì bắt buộc phải lấy báo giá từ ít nhất 3 đơn vị cung cấp. Mục đích là so sánh giá cả và chất lượng để chọn nhà cung cấp phù hợp nhất.
Bước 3: Gửi báo giá cho cấp trên để xét duyệt. Có hai khả năng:
Không được duyệt: Quy trình dừng lại.
Được duyệt: Tiếp tục thực hiện các bước tiếp theo.
Bước 4: Tiến hành mua hàng. Có 2 khả năng:
Ứng tiền của bản thân trước để mua hàng. (Nếu điều kiện tài chính cá nhân cho phép)
Xin tạm ứng (Advance Payment Request) nếu giá trị đơn hàng lớn. Bạn hãy điền form xin tạm ứng để được ứng tiền trước từ team 300.

Bước 5: Sau khi mua hàng xong cần yêu cầu nhà cung cấp xuất hóa đơn và các chứng từ liên quan. Thông tin hóa đơn cần bao gồm: Tên công ty, địa chỉ, mã số thuế.
Khi nhận được các hóa đơn, nếu bạn thuộc công ty nào hãy gửi chứng từ vào địa chỉ email tương ứng như sau:
ADD GROUP: 300@add-group.com
VPA: info@planadd.com
ASG: info@add-group.net

2. Quy trình Thanh toán - Tạm ứng
- Nếu bạn ứng tiền của bản thân trước để mua hàng, sau khi có hóa đơn hãy điền Form Đề nghị thanh toán theo đúng công ty của mình.
 - Nếu bạn xin tạm ứng (Advance Payment Request), sau khi có hóa đơn hãy điền Form Đề nghị hoàn ứng để trả lại tiền thừa cho công ty hoặc được công ty trả thêm tiền nếu trước đó thanh toán vượt quá số tiền đã được tạm ứng.

3. Chứng từ, hóa đơn
- Nếu bạn mua hàng từ 200.000VNĐ trở lên, cần có hóa đơn tài chính. (Trường hợp không có hóa đơn cần trao đổi với team 300 để cân đối hóa đơn chi phí).
- Lưu ý: nên yêu cầu nhà cung cấp xuất hóa đơn nháp và gửi cho team 300 kiểm tra trước, sau đó mới yêu cầu xuất hóa đơn chính thức.

- Nên gộp các khoản nhỏ, lẻ dưới 100.000 và thanh toán 1 lần với giá trị tổng.
Thông tin xuất VAT của các công ty:
ADD GROUP:
Tên công ty: CÔNG TY CỔ PHẦN TẬP ĐOÀN ĐẦU TƯ VÀ XÂY DỰNG ADD
MST: 0105469913
Địa chỉ: Tầng 3, tòa nhà Dolphin Plaza, Số 28 Trần Bình, Phường Từ Liêm, Thành phố Hà Nội, Việt Nam

VPA
Tên công ty: CÔNG TY TRÁCH NHIỆM HỮU HẠN PLAN ADD VIỆT NAM
MST: 0103028462
Địa chỉ: Tầng 3, Tòa nhà Dolphin Plaza, Số 28 Trần Bình, Phường Từ Liêm, Thành phố Hà Nội, Việt Nam

Đặc biệt:
Phí Grab, Bee: đăng ký tài khoản Công ty để lấy được hóa đơn chi phí cho doanh nghiệp
Chi phí hỗ trợ xăng xe: lập bảng chi tiết chặng đường di chuyển (https://docs.google.com/spreadsheets/d/1pTiPBSHG6vgyc9jfSHDqRLNHMlyU07WlPeCkL7V4Omw/edit?usp=sharing)
      => Tổng tiền cuối tháng có xác nhận của Trưởng phòng.

  `;
}

// ======================================================================
// STAMP DOCUMENT — Đăng ký sử dụng con dấu
// ======================================================================

/**
 * Xây dựng dialog form Đăng ký sử dụng con dấu.
 * Cấu trúc theo đúng ảnh UI:
 *   - 5 trường bắt buộc: Tên & mã dự án, Tên tài liệu, Số tài liệu, Số bản, Địa điểm
 *   - Dấu tròn (RADIO — chỉ chọn 1): ADD Group, VPA, TYM, CESS, ADD Con, VPAHCM, WORKSMATE
 *   - Dấu chữ ký / chức danh (CHECKBOX — nhiều): Boss' signature, Boss' title,
 *       Ms.Huong's signature, Ms.Huong's title, Madam Kim's title
 *   - Dấu khác (CHECKBOX — nhiều): Appraisal Stamp, Asbuilt Stamp
 */
function buildStampDocumentDialog() {
  return {
    body: {
      sections: [
        // ── SECTION 1: Thông tin tài liệu ──────────────────────────────
        {
          header: '🔏 <b>Đăng ký sử dụng con dấu</b>\nThông tin tài liệu:',
          widgets: [
            {
              textInput: {
                name: 'projectNameInput',
                label: '📂 Tên và mã dự án *',
                type: 'SINGLE_LINE',
                value: '',
              }
            },
            {
              textInput: {
                name: 'docNameInput',
                label: '📄 Tên tài liệu cần đóng dấu * ',
                type: 'SINGLE_LINE',
                value: ''
              }
            },
            {
              textInput: {
                name: 'docNumberInput',
                label: '🔢 Số tài liệu (VD: 2211/2022/HĐXD/ESSA-ADD) * ',
                type: 'SINGLE_LINE',
                value: '',
              }
            },
            {
              textInput: {
                name: 'copiesInput',
                label: '📋 Số bản cần đóng dấu *',
                type: 'SINGLE_LINE',
                value: '',
              }
            },
          ]
        },
        {
          header: '📍 Địa điểm sử dụng dấu:',
          widgets: [
            {
              selectionInput: {
                name: 'locationInput',
                type: 'RADIO_BUTTON',
                items: [
                  { text: 'Dùng tại văn phòng', value: 'Dùng tại văn phòng', selected: true },
                  { text: 'Mang ra ngoài', value: 'Mang ra ngoài', selected: false }
                ]
              }
            }
          ]
        },

        // ── SECTION 2: LOẠI DẤU CẦN SỬ DỤNG ────────────────────────────
        {
          header: '🏷️ <b>LOẠI DẤU CẦN SỬ DỤNG:</b>',
          widgets: [
            {
              textParagraph: {
                text: '💮 Dấu tròn:'
              }
            },
            {
              selectionInput: {
                name: 'roundStampInput',
                type: 'CHECK_BOX',
                items: [
                  { text: 'ADD Group Stamp — Dấu tròn ADD Group', value: 'ADD Group Stamp — Dấu tròn ADD Group', selected: false },
                  { text: 'VPA Stamp — Dấu tròn VPA', value: 'VPA Stamp — Dấu tròn VPA', selected: false },
                  { text: 'TYM Stamp — Dấu tròn TYM', value: 'TYM Stamp — Dấu tròn TYM', selected: false },
                  { text: 'CESS Stamp — Dấu tròn CESS', value: 'CESS Stamp — Dấu tròn CESS', selected: false },
                  { text: 'ASG Stamp - Dấu tròn ASG', value: 'ASG Stamp - Dấu tròn ASG', selected: false },
                  { text: 'ADD Con Stamp — Dấu tròn ADD Con', value: 'ADD Con Stamp — Dấu tròn ADD Con', selected: false },
                  { text: 'VPAHCM Stamp — Dấu tròn VPAHCM', value: 'VPAHCM Stamp — Dấu tròn VPAHCM', selected: false },
                  { text: 'WSM VPĐD Stamp — Dấu tròn WSM VPĐD', value: 'WSM VPĐD Stamp — Dấu tròn WSM VPĐD', selected: false },
                  { text: 'WORKSMATE Stamp — Dấu tròn Worksmate', value: 'WORKSMATE Stamp — Dấu tròn Worksmate', selected: false }
                ]
              }
            }
          ]
        },

        // ── SECTION 3: Dấu chữ ký / chức danh (CHECKBOX) ──────────────
        {
          header: '✒️ Dấu chữ ký - Dấu chức danh :',
          widgets: [
            {
              selectionInput: {
                name: 'signatureStampInput',
                type: 'CHECK_BOX',
                items: [
                  { text: "Boss' signature — Dấu chữ ký Boss", value: "Boss' signature — Dấu chữ ký Boss", selected: false },
                  { text: "Boss' title — Dấu chức danh Boss", value: "Boss' title — Dấu chức danh Boss", selected: false },
                  { text: "Ms.Huong's signature — Dấu chữ ký Ms. Hương", value: "Ms.Huong's signature — Dấu chữ ký Ms. Hương", selected: false },
                  { text: "Ms.Huong's title — Dấu chức danh Ms. Hương", value: "Ms.Huong's title — Dấu chức danh Ms. Hương", selected: false },
                  { text: "Mr.Thuyết's title — Dấu chức danh Mr. Thuyết", value: "Mr.Thuyết's title — Dấu chức danh Mr. Thuyết", selected: false },
                  { text: "Madam Kim's title — Dấu chức danh Madam Kim", value: "Madam Kim's title — Dấu chức danh Madam Kim", selected: false }
                ]
              }
            }
          ]
        },

        // ── SECTION 4: Dấu khác (CHECKBOX) ────────────────────────────
        {
          header: '🔶 Dấu khác :',
          widgets: [
            {
              selectionInput: {
                name: 'otherStampInput',
                type: 'CHECK_BOX',
                items: [
                  { text: 'Appraisal Stamp — Dấu Thẩm tra', value: 'Appraisal Stamp — Dấu Thẩm tra', selected: false },
                  { text: 'Asbuilt Stamp — Dấu hoàn công', value: 'Asbuilt Stamp — Dấu hoàn công', selected: false }
                ]
              }
            },
            {
              textParagraph: {
                text: '<b><i>⚠️ DÙNG XONG DẤU VUI LÒNG TRẢ LẠI!!!</i></b>'
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Submit',
                    onClick: {
                      action: {
                        functionName: 'submitStampDocument',
                        parameters: [
                          { key: 'action', value: 'submitStampDocument' }
                        ]
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  };
}

/**
 * Xử lý submit form Đăng ký sử dụng con dấu.
 * Ghi dữ liệu vào Google Sheet và gửi thông báo đến phòng 200.
 *
 * Cột trong sheet (theo ảnh chụp màn hình):
 *   A  = Trạng thái (để trống, nhân viên phòng 200 cập nhật sau)
 *   B  = Dấu thời gian (timestamp)
 *   C  = Địa chỉ email (user.email)
 *   D  = Name / Tên người đăng ký (user.displayName)
 *   E  = Project name & ID / Tên và mã dự án
 *   F  = Type of Stamp / Loại dấu cần sử dụng
 *   G  = Document name / Tên tài liệu cần đóng dấu
 *   H  = Number of copies / Số bản cần đóng dấu
 *   I  = Image/Scan (để trống)
 *   J  = Document No / Số tài liệu
 *   K  = Địa điểm sử dụng con dấu
 */
function submitStampDocument(event) {
  try {
    // ── 1. Lấy sheet theo năm hiện tại ─────────────────────────────────
    var ss = SpreadsheetApp.openById(STAMP_DOC_SPREADSHEET_ID);
    var currentYear = new Date().getFullYear().toString();
    var sheet = ss.getSheetByName(currentYear) || ss.getSheetByName('2026') || ss.getSheets()[0];

    if (!sheet) {
      return {
        actionResponse: {
          type: 'DIALOG',
          dialogAction: {
            actionStatus: {
              statusCode: 'NOT_FOUND',
              userFacingMessage: 'Không tìm thấy sheet Đăng ký con dấu!'
            }
          }
        }
      };
    }

    // ── 2. Đọc form inputs ──────────────────────────────────────────────
    var formInputs = (event.common && event.common.formInputs) ? event.common.formInputs : {};

    var projectName = safeTrim(getValue(formInputs.projectNameInput) || '');
    var docName = safeTrim(getValue(formInputs.docNameInput) || '');
    var docNumber = safeTrim(getValue(formInputs.docNumberInput) || '');
    var copies = safeTrim(getValue(formInputs.copiesInput) || '');
    var location = safeTrim(getValue(formInputs.locationInput) || 'Dùng tại văn phòng');

    // Dấu tròn (CHECKBOX — nhiều giá trị)
    var roundStamps = [];
    try {
      var rsInput = formInputs['roundStampInput'];
      if (rsInput && rsInput[''] && rsInput[''].stringInputs && rsInput[''].stringInputs.value) {
        roundStamps = rsInput[''].stringInputs.value;
      }
    } catch (e) { }

    // Dấu chữ ký / chức danh (CHECKBOX — nhiều giá trị)
    var signatureStamps = [];
    try {
      var ssInput = formInputs['signatureStampInput'];
      if (ssInput && ssInput[''] && ssInput[''].stringInputs && ssInput[''].stringInputs.value) {
        signatureStamps = ssInput[''].stringInputs.value;
      }
    } catch (e) { }

    // Dấu khác (CHECKBOX — nhiều giá trị)
    var otherStamps = [];
    try {
      var osInput = formInputs['otherStampInput'];
      if (osInput && osInput[''] && osInput[''].stringInputs && osInput[''].stringInputs.value) {
        otherStamps = osInput[''].stringInputs.value;
      }
    } catch (e) { }

    // ── 3. Validation 5 trường bắt buộc ────────────────────────────────
    if (!projectName) {
      return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Vui lòng nhập Tên và mã dự án!' } } } };
    }
    if (!docName) {
      return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Vui lòng nhập Tên tài liệu cần đóng dấu!' } } } };
    }
    if (!docNumber) {
      return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Vui lòng nhập Số tài liệu!' } } } };
    }
    if (!copies) {
      return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Vui lòng nhập Số bản cần đóng dấu!' } } } };
    }
    if (!location) {
      return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Vui lòng chọn Địa điểm sử dụng con dấu!' } } } };
    }

    // ── 4. Gộp danh sách loại dấu thành chuỗi để lưu vào cột E ─────────
    var allStamps = [];
    roundStamps.forEach(function (s) { if (s) allStamps.push(s); });
    signatureStamps.forEach(function (s) { if (s) allStamps.push(s); });
    otherStamps.forEach(function (s) { if (s) allStamps.push(s); });
    var stampTypeStr = allStamps.join(', ');

    // ── 5. Ghi vào Sheet (append xuống dưới — mới nhất ở cuối) ─────────
    var timestamp = new Date();
    var userEmail = (event.user && event.user.email) || '';
    var userDisplayName = (event.user && event.user.displayName) || userEmail || 'Unknown User';
    var user = userDisplayName; // dùng cho thông báo chat/email
    var space = (event.space && event.space.name) ? event.space.name : '';

    // Append vào hàng cuối cùng có dữ liệu + 1 (mới nhất ở dưới, theo thứ tự thời gian)
    var lastRow = sheet.getLastRow() + 1;

    sheet.getRange(lastRow, 1).setValue('');              // Cột A: Trạng thái (phòng 200 cập nhật)
    sheet.getRange(lastRow, 2).setValue(timestamp);       // Cột B: Dấu thời gian
    sheet.getRange(lastRow, 3).setValue(userEmail);       // Cột C: Địa chỉ email
    sheet.getRange(lastRow, 4).setValue(userDisplayName); // Cột D: Name / Tên người đăng ký
    sheet.getRange(lastRow, 5).setValue(projectName);     // Cột E: Project name & ID / Tên và mã dự án
    sheet.getRange(lastRow, 6).setValue(stampTypeStr);    // Cột F: Type of Stamp / Loại dấu cần sử dụng
    sheet.getRange(lastRow, 7).setValue(docName);         // Cột G: Document name / Tên tài liệu cần đóng dấu
    sheet.getRange(lastRow, 8).setValue(copies);          // Cột H: Number of copies / Số bản cần đóng dấu
    sheet.getRange(lastRow, 9).setValue('');              // Cột I: Image/Scan (để trống)
    sheet.getRange(lastRow, 10).setValue(docNumber);      // Cột J: Document No / Số tài liệu
    sheet.getRange(lastRow, 11).setValue(location);      // Cột K: Địa điểm sử dụng con dấu

    // ── 6. Gửi xác nhận cho người đăng ký ──────────────────────────────
    var stampLines = allStamps.map(function (s) {
      return '  • ' + s;
    }).join('\n');

    var confirmMsg = '*Bạn đã đăng ký thành công sử dụng con dấu ✅:*\n' +
      (stampLines || '(Chưa chọn)') + '\n\n' +
      '*⚠️ VUI LÒNG TRẢ DẤU KHI ĐÓNG XONG! NẾU CÓ THỂ HÃY ĐÓNG DẤU TẠI DÃY BÀN 200*';
    if (space) {
      sendMessageByChatBot({ text: confirmMsg }, space);
    }

    // ── 7. Gửi Thẻ thông báo kèm nút ACCEPT/REJECT đến nhóm 200.Notification (spaces/AAQA2_sKqYQ) ────────────
    var notifyMsg = {
      cardsV2: [{
        card: {
          header: {
            title: '🔏 STAMP DOCUMENT',
            subtitle: '⏳ ' + convertDateToVietnamFormat(timestamp),
            imageUrl: 'https://thumbs.dreamstime.com/b/valid-red-stamp-white-background-437756946.jpg'
          },
          sections: [{
            widgets: [
              { textParagraph: { text: '- <b>Người đăng ký</b>: ' + user } },
              { textParagraph: { text: '- <b>Dự án</b>: ' + projectName } },
              { textParagraph: { text: '- <b>Tên tài liệu</b>: ' + docName } },
              { textParagraph: { text: '- <b>Số tài liệu</b>: ' + docNumber } },
              { textParagraph: { text: '- <b>Số bản</b>: ' + copies } },
              { textParagraph: { text: '- <b>Địa điểm</b>: ' + location } },
              { textParagraph: { text: '- <b>Loại dấu</b>:\n' + allStamps.map(function (s) { return '  • ' + s; }).join('\n') } },
              {
                buttonList: {
                  buttons: [
                    {
                      text: '✅ STAMP RETURNED',
                      onClick: {
                        action: {
                          'function': 'approveStampReturn',
                          parameters: [
                            { key: 'action', value: 'approveStampReturn' },
                            { key: 'row', value: String(lastRow) },
                            { key: 'staff', value: user },
                            { key: 'docName', value: docName },
                            { key: 'projectName', value: projectName },
                            { key: 'stampType', value: stampTypeStr },
                            { key: 'userSpace', value: space }
                          ]
                        }
                      }
                    },

                  ]
                }
              }
            ]
          }],
          fixedFooter: {
            primaryButton: {
              text: 'Xem Google Sheet',
              onClick: {
                openLink: {
                  url: 'https://docs.google.com/spreadsheets/d/' + STAMP_DOC_SPREADSHEET_ID + '/edit'
                }
              }
            }
          }
        }
      }]
    };

    sendMessageByChatBot(notifyMsg, 'spaces/AAQA2_sKqYQ');
    Logger.log('submitStampDocument: Gửi thẻ thông báo đến 200.Notification (spaces/AAQA2_sKqYQ)');

    // ── 8. Đóng dialog ──────────────────────────────────────────────────
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'OK',
            userFacingMessage: 'Bạn đã đăng ký thành công sử dụng con dấu ✅:\n' +
              (stampLines || '(Chưa chọn)') + '\n\n' +
              '⚠️ VUI LÒNG TRẢ DẤU KHI ĐÓNG XONG! NẾU CÓ THỂ HÃY ĐÓNG DẤU TẠI DÃY BÀN 200'
          }
        }
      }
    };

  } catch (error) {
    Logger.log('submitStampDocument error: ' + error.message);
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: {
            statusCode: 'INTERNAL',
            userFacingMessage: 'Có lỗi xảy ra: ' + error.message
          }
        }
      }
    };
  }
}
// ============================== FORM LINKS (CHƯƠNG 3 – CÁC ĐƯỜNG LINK, FORM MẪU CHUNG) ==============================
/**
 * Danh sách form mẫu chung từ CHƯƠNG 3 – nội quy công ty.
 * Mỗi entry gồm: keywords (mảng từ khóa nhận dạng) và url (đường link trực tiếp).
 */
var COMPANY_FORM_LINKS = [
  {
    name: 'Form đề nghị thanh toán online của ADD',
    keywords: ['đề nghị thanh toán', 'thanh toán online add', 'form thanh toán add', 'thanh toán add', 'payment add', 'đề nghị thanh toán add'],
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSdxe1Ys-EBR473wpqbr_0HIL4Wr0S4A9G6xE8sT-CZmT-gNoQ/viewform?pli=1'
  },
  {
    name: 'Form đề nghị thanh toán online của VPA',
    keywords: ['thanh toán vpa', 'form thanh toán vpa', 'đề nghị thanh toán vpa', 'payment vpa', 'thanh toán online vpa'],
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSe1RL2H8ETmaz2adT7PJMUdxMxkFjZiKDbfuEpnMIfbv_g0nw/viewform?pli=1'
  },
  {
    name: 'Form đăng ký mua văn phòng phẩm',
    keywords: ['văn phòng phẩm', 'vpp', 'mua văn phòng phẩm', 'form vpp', 'đăng ký vpp', 'office supply', 'officesupply'],
    url: 'https://docs.google.com/spreadsheets/d/10Czvm2uyipN67r39h8_I6c3kVBMZTOE7dS8jwIa-QUQ/edit?usp=sharing'
  },
  {
    name: 'Form đề nghị làm thêm giờ',
    keywords: ['làm thêm giờ', 'tăng ca', 'ot', 'overtime', 'form tăng ca', 'đăng ký tăng ca', 'form ot', 'làm thêm'],
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSfAo1y1wvJXqFjfBVdUAT5hUaPuH9BIdERLvYDjLImj9qmXwQ/viewform'
  },
  {
    name: 'Schedule Form – tiến độ công việc',
    keywords: ['schedule form', 'tiến độ công việc', 'lịch công việc', 'tiến độ dự án', 'schedule', 'kế hoạch công việc'],
    url: 'https://docs.google.com/spreadsheets/d/1_Vs44xzlsuK-A0dB9wYuZo27GQ2ySQUwcWQgX6olr1Y/edit?usp=sharing'
  },
  {
    name: 'Form báo cáo cuộc họp (Meeting report)',
    keywords: ['báo cáo cuộc họp', 'meeting report', 'biên bản cuộc họp', 'họp', 'meeting', 'form họp'],
    url: 'https://docs.google.com/spreadsheets/d/1o8JoVz4wiad_t4Rd1jwKWzPmToDaqcOQs1HPJY4GFRc/edit?gid=923456535#gid=923456535'
  },
  {
    name: 'Biên bản bàn giao hồ sơ',
    keywords: ['biên bản bàn giao hồ sơ', 'ban giao ho so', 'bàn giao hồ sơ'],
    url: 'https://docs.google.com/document/d/1VKoHv-cZWJ5CEalfpicM9kEZzLeDjwc-_5vj41a0L6Q/edit?tab=t.0'
  },
  {
    name: 'Bảng báo giá thiết kế',
    keywords: ['báo giá thiết kế', 'báo giá', 'bảng báo giá', 'thiết kế', 'quotation design'],
    url: 'https://docs.google.com/spreadsheets/d/14FV5b7pdufZQdDkqgbD64tlsiHA2t9W22WulsGjjCwQ/edit?usp=sharing'
  },
  {
    name: 'Báo cáo giám sát đầu tư',
    keywords: ['giám sát đầu tư', 'báo cáo đầu tư', 'investment report', 'báo cáo giám sát'],
    url: 'https://docs.google.com/document/d/1waep2V9LD_2JUa2E4EhRm0Qz7-3yo_RWd7ddlwQxBjQ/edit?tab=t.0'
  },
  {
    name: 'Biên nhận tiền',
    keywords: ['biên nhận tiền', 'nhận tiền', 'biên nhận', 'receipt'],
    url: 'https://docs.google.com/spreadsheets/d/1klLDvMQeAbTGzb385kCfZPz2E003ATjBE7A97dTRWw0/edit?gid=444784611#gid=444784611'
  },
  {
    name: 'Đề nghị hoàn ứng',
    keywords: ['hoàn ứng', 'đề nghị hoàn ứng', 'form hoàn ứng', 'hoan ung'],
    url: 'https://docs.google.com/spreadsheets/d/1czGIu08W4R_9ig1PdZMGDJA-thQKLIWZjgxwGuaAA4k/edit?gid=980403237#gid=980403237'
  },
  {
    name: 'Đề nghị tạm ứng',
    keywords: ['tạm ứng', 'đề nghị tạm ứng', 'form tạm ứng', 'tam ung'],
    url: 'https://docs.google.com/spreadsheets/d/1R4Rgj8W5ghKMfK3E4KNdgnB1dpvAZBys80u_qAQ1KW0/edit?usp=sharing'
  },
  {
    name: 'Đơn xin nghỉ phép',
    keywords: ['đơn nghỉ phép', 'đơn xin nghỉ phép', 'form nghỉ phép', 'xin nghỉ phép', 'don nghi phep'],
    url: 'https://docs.google.com/document/d/1fm_PRf0zIFyYBhYVPyO10ceEPCxV8AWcACDdZiJOgwk/edit?usp=sharing'
  },
  {
    name: 'Đơn xin nghỉ việc',
    keywords: ['đơn nghỉ việc', 'đơn xin nghỉ việc', 'form nghỉ việc', 'xin nghỉ việc', 'don nghi viec', 'thôi việc'],
    url: 'https://docs.google.com/document/d/1_rshuPSWNxTh18FRAJQ6WNIPPU2bMVc8al_-Aziw8XI/edit?usp=sharing'
  },
  {
    name: 'Đơn nghỉ thai sản',
    keywords: ['thai sản', 'nghỉ thai sản', 'đơn thai sản', 'maternity leave', 'don thai san'],
    url: 'https://docs.google.com/document/d/1komIN7xQH4ZzrzAj58nbHEDfHsbtMl9ACUohZTPcgOA/edit?usp=sharing'
  },
  {
    name: 'Mẫu hồ sơ nhân viên',
    keywords: ['hồ sơ nhân viên', 'mẫu nhân viên', 'hồ sơ tuyển dụng', 'mau ho so nhan vien', 'profile nhân viên'],
    url: 'https://docs.google.com/spreadsheets/d/1oyKTdbTNqeba_juvskDGDueucPco3OQdsPQ4nnav9DM/edit?gid=374638353#gid=374638353'
  },
  {
    name: 'Thỏa thuận chấm dứt hợp đồng',
    keywords: ['thỏa thuận chấm dứt', 'chấm dứt hợp đồng thỏa thuận', 'thoa thuan cham dut'],
    url: 'https://docs.google.com/spreadsheets/d/1sFLPT5bRvdLpc3spd2fcYKw5sESMxdmQm_HacRVYT78/edit?gid=1222850533#gid=1222850533'
  },
  {
    name: 'Đăng ký đổi khung giờ làm việc',
    keywords: ['đổi khung giờ', 'khung giờ làm việc', 'đăng ký giờ', 'đổi giờ làm', 'form đổi giờ', 'change working hours'],
    url: 'https://docs.google.com/spreadsheets/d/1Tg3tU2ILUvTSt7S9RJaPLhipOnXkO0xqEimbiEb9N30/edit?gid=2026000455#gid=2026000455'
  },
  {
    name: 'Biên bản vụ việc',
    keywords: ['biên bản vụ việc', 'bien ban vu viec', 'incident report', 'vụ việc'],
    url: 'https://docs.google.com/document/d/1w8szPvWJVqSGW0ERshLma7n9FKCDjEGnUbHxDwqGRQE/edit?tab=t.0'
  },
  {
    name: 'Biên bản bàn giao công việc',
    keywords: ['bàn giao công việc', 'biên bản bàn giao công việc', 'handover', 'ban giao cong viec'],
    url: 'https://docs.google.com/spreadsheets/d/1SdZUI8k4keP1SatVjKeQVelTz5vbO7iGJCnUx0_Yo7U/edit?gid=1801370334#gid=1801370334'
  },
  {
    name: 'Thông báo chấm dứt Hợp đồng lao động',
    keywords: ['thông báo chấm dứt hợp đồng lao động', 'thông báo chấm dứt hdld', 'notice of termination'],
    url: 'https://docs.google.com/document/d/1wUUsxsRiPRL8-cj1Yz5FZv23WXylJ0Doux3nXqxUCGI/edit?tab=t.0'
  },
  {
    name: 'Quyết định chấm dứt Hợp đồng lao động',
    keywords: ['quyết định chấm dứt hợp đồng lao động', 'quyết định chấm dứt hdld', 'decision of termination'],
    url: 'https://docs.google.com/document/d/15wAmSmijd99MshV8rfdd0dedcBqCk9oTVXDn5hl1TSQ/edit?tab=t.0'
  },
  {
    name: 'Biên bản bàn giao tài sản',
    keywords: ['bàn giao tài sản', 'biên bản bàn giao tài sản', 'asset handover', 'ban giao tai san'],
    url: 'https://docs.google.com/spreadsheets/d/1CIUmmnq7u9Ozluyv1rG3gyB2y5X7mB2uEJoe0DvzmLQ/edit?gid=707200935#gid=707200935'
  },
  {
    name: 'Giấy giới thiệu',
    keywords: ['giấy giới thiệu', 'giay gioi thieu', 'introduction letter', 'letter of introduction'],
    url: 'https://docs.google.com/document/d/0Bw_u1f220kn1WEdfTUk3NDNEblU/edit?resourcekey=0-y0DtHIX_Ij4Lo9ssEzvksw'
  },
  {
    name: 'Giấy ủy quyền',
    keywords: ['giấy ủy quyền', 'ủy quyền', 'giay uy quyen', 'power of attorney', 'authorization letter'],
    url: 'https://docs.google.com/document/d/1_lYrwtr7oLxMt4eDD7cfJDuoCSWO2SoBu2Rqt9Reses/edit?tab=t.0'
  },
  {
    name: 'Mẫu công văn',
    keywords: ['mẫu công văn', 'công văn', 'cong van', 'official letter', 'form công văn'],
    url: 'https://docs.google.com/document/d/1yPln3KUOJeWJ_8rlLWudChQxF5bPqSW6lTIMZX6iFDQ/edit?tab=t.0'
  },
  {
    name: 'Biên bản giao nhận hồ sơ',
    keywords: ['biên bản giao nhận hồ sơ', 'giao nhận hồ sơ', 'bien ban giao nhan ho so'],
    url: 'https://docs.google.com/spreadsheets/d/1bB5ub5kA37w2qR40RI2tFfgMl01YZYuf9jgYDfb2yVI/edit?gid=0#gid=0'
  },
  {
    name: 'Form đăng ký mượn tài liệu, hồ sơ',
    keywords: ['mượn tài liệu', 'mượn hồ sơ', 'đăng ký mượn', 'muon tai lieu', 'muon ho so', 'borrow documents'],
    url: 'https://forms.gle/NA8HX2ARpWuAQFrS7'
  }
];

/**
 * Kiểm tra xem câu hỏi có phải là hỏi về form/link mẫu chung trong CHƯƠNG 3 hay không.
 * Ưu tiên xử lý TRƯỚC khi đẩy vào Drive Search.
 */
function isFormLinkRequest(text) {
  if (!text) return false;
  var lower = removeAccents(text.toLowerCase().trim());

  // Phải có từ khóa ý định hỏi link/form
  var intentPattern = /\b(form|link|m[aă]u|where|cho t[ôo]i|d[aă]u|[aă]o d[aâ]u|t[aà]i li[eê]u|mượn|bieu mau|mau|h[oô] s[oơ]|don)\b/i;
  if (!intentPattern.test(lower)) return false;

  // Kiểm tra trong danh sách COMPANY_FORM_LINKS
  for (var i = 0; i < COMPANY_FORM_LINKS.length; i++) {
    var entry = COMPANY_FORM_LINKS[i];
    for (var k = 0; k < entry.keywords.length; k++) {
      var kw = removeAccents(entry.keywords[k].toLowerCase());
      if (lower.indexOf(kw) !== -1) return true;
    }
  }
  return false;
}

/**
 * Xử lý câu hỏi về form/link mẫu chung từ CHƯƠNG 3.
 * Trả về tất cả form khớp với từ khóa trong câu hỏi.
 */
function handleFormLinkRequest(text, displayName) {
  var lower = removeAccents(text.toLowerCase().trim());
  var matched = [];

  for (var i = 0; i < COMPANY_FORM_LINKS.length; i++) {
    var entry = COMPANY_FORM_LINKS[i];
    for (var k = 0; k < entry.keywords.length; k++) {
      var kw = removeAccents(entry.keywords[k].toLowerCase());
      if (lower.indexOf(kw) !== -1) {
        matched.push(entry);
        break;
      }
    }
  }

  if (matched.length === 0) return null;

  // Nếu chỉ 1 kết quả → trả link trực tiếp
  if (matched.length === 1) {
    var f = matched[0];
    return {
      cardsV2: [{
        card: {
          header: {
            title: '📋 FORM MẪU CHUNG',
            subtitle: 'Dành cho ' + displayName,
            imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/article/default/24px.svg'
          },
          sections: [{
            widgets: [
              { textParagraph: { text: '<b>' + f.name + '</b>' } },
              {
                buttonList: {
                  buttons: [{
                    text: '🔗 Mở Form / Tài liệu',
                    onClick: { openLink: { url: f.url } },
                    color: { red: 0.1, green: 0.53, blue: 0.82, alpha: 1 }
                  }]
                }
              }
            ]
          }]
        }
      }]
    };
  }

  // Nhiều kết quả → liệt kê dưới dạng danh sách với nút bấm cho từng form
  var widgets = [{ textParagraph: { text: '✅ Tìm thấy <b>' + matched.length + '</b> tài liệu phù hợp:' } }];
  for (var j = 0; j < matched.length; j++) {
    var fm = matched[j];
    widgets.push({
      buttonList: {
        buttons: [{
          text: '📄 ' + fm.name,
          onClick: { openLink: { url: fm.url } }
        }]
      }
    });
  }

  return {
    cardsV2: [{
      card: {
        header: {
          title: '📋 FORM MẪU CHUNG',
          subtitle: 'Kết quả cho: ' + displayName,
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/article/default/24px.svg'
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

// ============================== GOOGLE CHAT LINK AGENT (DRIVE SEARCH) ==============================
var DRIVE_ROOT_FOLDER_URL = "https://drive.google.com/drive/folders/0B_q5HyYkeLftU1NNSzhDWnRYVzA?resourcekey=0-FmSJ1KEXM9RveZhA52ikbg";
var DRIVE_ROOT_FOLDER_ID = "0B7_7N-cPDf2ObnNlRjhYTHBqaFE";
var DRIVE_ROOT_RESOURCE_KEY = "0-1nMkZNSFxT89iKtAWEsleQ";

var LINK_TRIGGER_KEYWORDS = [
  "link", "tài liệu", "file", "folder", "thư mục", "drive",
  "cần link", "cần file", "tìm file", "tìm tài liệu", "tìm link", "lấy file", "gửi link",
  "điều lệ", "quyết định", "giấy phép",
  "hợp đồng", "sổ đỏ", "báo cáo", "211",
  "210", "220", "230", "240", "250", "260", "270", "280", "290",
  "erc", "irc", "đăng ký kinh doanh", "nhãn hiệu", "đấu thầu",
  "con dấu", "chữ ký", "nhân sự", "tài sản", "văn phòng",
  "thành viên", "góp vốn", "cổ đông", "cổ phần", "tỷ lệ", "thoogn", "thong tin",
  "hết hạn", "thời hạn", "hiệu lực", "khi nào", "bao giờ", "ngày hết hạn", "hạn hoạt động", "còn hạn",
  "주주", "지분", "지분율", "대표", "자본금", "주소", "법인", "정보", "누구", "어떻게", "만기", "만료", "유효", "기간",
  "shareholder", "shareholding", "share", "capital", "owner", "who", "what", "how much", "info", "details", "expire", "expiry", "validity"
];

function isLinkRequest(text) {
  if (!text) return false;
  var lower = text.toLowerCase().trim();

  // Bỏ qua nếu đây là câu hỏi về Penalty & Bonus, Ngày phép, Chấm công, Ngày công, Đi muộn, Vệ sinh, Vé máy bay... để không bị nhầm thành tìm file Drive
  if (/penalty|bonus|phạt|thưởng|tim|bom|❤️|💣|điểm|đánh giá|phép|phéo|vacation|leave|nghỉ|chấm công|dữ liệu chấm công|muộn|trễ|quên|về sớm|tổng công|ngày công|số công|công tháng|đi làm|checkin|checkout|vé máy bay|lịch bay|ngày bay|chuyến bay|vé bay|vé sếp|lịch sếp|sếp bay|madam|flight|vệ sinh|dọn dẹp/.test(lower)) {
    return false;
  }

  // 🌟 NẾU LÀ CÂU HỎI TRÍCH XUẤT THÔNG TIN / CHỈ SỐ DOANH NGHIỆP (Mã số thuế, vốn điều lệ, người đại diện...) -> Kích hoạt ngay luồng Drive Search & AI Extraction
  if (typeof isInfoExtractionRequest === 'function' && isInfoExtractionRequest(lower)) {
    return true;
  }

  // Bỏ qua các câu hỏi giao tiếp hoặc thắc mắc quy chế/thử việc thông thường không chỉ định file
  if (!/link|tài liệu|file|folder|thư mục|drive|211|erc|irc|sổ đỏ|báo cáo|điều lệ|hợp đồng|giấy phép/i.test(lower)) {
    // Nếu không chứa các từ chỉ định tài liệu/file cụ thể thì KHÔNG đẩy vào Drive Search
    return false;
  }

  for (var i = 0; i < LINK_TRIGGER_KEYWORDS.length; i++) {
    if (lower.indexOf(LINK_TRIGGER_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

function isInfoExtractionRequest(text) {
  if (!text) return false;  var lower = text.toLowerCase().trim();

  // Bỏ qua nếu là câu xin/tìm file đơn thuần (VD: "cho tôi ERC của VPA", "tìm file ERC", "gửi link ERC")
  // CHỈ kích hoạt AI trích xuất thông tin khi người dùng hỏi các chi tiết / chỉ số cụ thể bên trong tài liệu.

  // 1. Tiếng Việt: Các từ khóa hỏi THÔNG TIN CỤ THỂ bên trong tài liệu (Mã số, Vốn, Người đại diện, Thời hạn...)
  var viPattern = /mã số|mã số thuế|msdn|mst|vốn|vốn điều lệ|góp vốn|thành viên|cổ đông|cổ phần|tỷ lệ|phần vốn|địa chỉ|trụ sở|người đại diện|đại diện|giám đốc|chủ sở hữu|ngày cấp|đăng ký lần đầu|đăng ký thay đổi|đại diện pháp luật|ai là|ai đứng tên|hết hạn|thời hạn|hiệu lực|khi nào|bao giờ|ngày hết hạn|hạn hoạt động|thời gian hoạt động|giá trị đến|còn hạn|quá hạn|hết hiệu lực|bao nhiêu|mấy năm|hạn đến|nội dung trong|trích xuất thông tin|bài toán vốn|tổng số vốn/i;

  // 2. Tiếng Hàn: Các từ khóa hỏi thông tin cụ thể (주주 - cổ đông, 지분율 - tỷ lệ, 대표 - đại diện, 자본금 - vốn, 등록번호 - mã số...)
  var koPattern = /주주|지분|지분율|대표|대표자|자본|자본금|주소|등록번호|법인|누구|어떻게|얼마|어디|원|퍼센트|%|만기|유효|기간|언제|만료/i;

  // 3. Tiếng Anh: Các từ khóa hỏi thông tin cụ thể (tax code, capital, representative, shareholder, expire, validity...)
  var enPattern = /shareholder|shareholding|share|equity|capital|address|representative|director|owner|tax code|business registration|who|what|how much|how many|percentage|ratio|expire|expiry|expiration|validity|valid|when|duration|period/i;

  return viPattern.test(lower) || koPattern.test(lower) || enPattern.test(lower);
}

function extractFileContent(fileId) {
  var cacheKey = "FILE_CONTENT_TXT_" + fileId;
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) return cached;
  } catch (ce) { }

  try {
    var file = DriveApp.getFileById(fileId);
    var mime = file.getMimeType();

    // 1. Google Docs
    if (mime === "application/vnd.google-apps.document") {
      var doc = DocumentApp.openById(fileId);
      var text = doc.getBody().getText();
      if (text && text.length > 10) {
        try { CacheService.getScriptCache().put(cacheKey, text.substring(0, 50000), 900); } catch (e) { }
        return text;
      }
    }

    // 2. Google Sheet / Excel
    if (mime === "application/vnd.google-apps.spreadsheet") {
      var ss = SpreadsheetApp.openById(fileId);
      var sheet = ss.getSheets()[0];
      var values = sheet.getDataRange().getValues();
      var sheetText = values.map(function (r) { return r.join(" | "); }).join("\n");
      if (sheetText) {
        try { CacheService.getScriptCache().put(cacheKey, sheetText.substring(0, 50000), 900); } catch (e) { }
        return sheetText;
      }
    }

    // 3. PDF Files (đọc PDF qua Base64 gửi cho Gemini Multimodal Vision API)
    if (mime === "application/pdf" || mime.indexOf("pdf") !== -1) {
      var blob = file.getBlob();
      var bytes = blob.getBytes();
      if (bytes.length < 8 * 1024 * 1024) { // Dưới 8MB để tránh bị tràn dung lượng UrlFetchApp
        var base64Data = Utilities.base64Encode(bytes);
        return { isPdfBlob: true, mimeType: "application/pdf", base64Data: base64Data };
      }
    }
  } catch (e) {
    Logger.log("extractFileContent error: " + e.toString());
  }
  return null;
}

function extractMentionedCompanies(text) {
  if (!text) return [];
  var companies = ["ADC", "ADD", "AGB", "ASG", "TYM", "VPA", "WORKSMATE", "SE ADD", "GEO ADD", "ADD CON"];
  var found = [];
  for (var i = 0; i < companies.length; i++) {
    var c = companies[i];
    var regex = new RegExp("\\b" + c + "\\b", "i");
    if (regex.test(text)) {
      found.push(c);
    }
  }
  return found;
}

function isCalculationOrMultiDocRequest(text) {
  if (!text) return false;
  var lower = text.toLowerCase();
  var companies = extractMentionedCompanies(text);

  var hasMultiCompanies = companies.length > 1;
  var hasCalcKeyword = /tổng|tổng vốn|tổng số|cộng lại|tính tổng|tất cả|tổng cộng|tổng số vốn|tổng tài sản|tổng cổ phần/i.test(lower);
  var hasMultiDocKeyword = /erc và irc|irc và erc|cả erc|cả irc|các công ty|nhiều công ty/i.test(lower);

  return hasMultiCompanies || (companies.length >= 1 && (hasCalcKeyword || hasMultiDocKeyword));
}

function multiDocumentFileQnA(userQuestion, selectedFiles) {
  if (!selectedFiles || selectedFiles.length === 0) return null;

  var API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!API_KEY) return null;

  var prompt = "Bạn là chuyên gia phân tích tài chính và pháp lý doanh nghiệp cao cấp 200 AI (Tập đoàn ADD / VPA / AGB / ADC / ASG / TYM VINA / Worksmate).\n" +
    "Người dùng đang đặt câu hỏi tổng hợp / tính toán trên NHIỀU TÀI LIỆU DƯỚI ĐÂY: \"" + userQuestion + "\".\n\n" +
    "QUY TẮC CỰC KỲ NGHIÊM NGẶT KHI NỘI DUNG TÀI LIỆU KHÔNG CHỨA THÔNG TIN ĐƯỢC HỎI:\n" +
    "- Nếu TẤT CẢ các tài liệu đều KHÔNG chứa thông tin về cá nhân/đối tượng được hỏi, BẮT BUỘC trả về: 'KHONG_TIM_THAY_THONG_TIN: [lý do ngắn gọn].'. TUYỆT ĐỐI KHÔNG liệt kê thông tin của người khác có trong tài liệu khi người dùng không hỏi về họ!\n\n" +
    "NHIỆM VỤ SUY LUẬN LOGIC VÀ TÍNH TOÁN:\n" +
    "1. ĐỌC TẤT CẢ CÁC TÀI LIỆU ĐƯỢC CUNG CẤP: Tìm và trích xuất chính xác số vốn góp (VNĐ hoặc USD) và tỷ lệ phần trăm sở hữu (%) của từng cá nhân / tổ chức được hỏi (ví dụ: 'Son Min Chang') trong TỪNG TÀI LIỆU VÀ TỪNG CÔNG TY THÀNH VIÊN.\n" +
    "2. THỰC HIỆN TÍNH TOÁN TỔNG CỘNG (CALCULATION):\n" +
    "   - Cộng tổng tất cả số tiền vốn góp VNĐ từ các công ty lại với nhau để ra TỔNG SỐ VỐN ĐÃ GÓP CỦA HỌ.\n" +
    "   - Nếu có cả số tiền USD, hãy cộng riêng tổng số tiền USD.\n" +
    "3. ĐỊNH DẠNG HTML GOOGLE CHAT CHUẨN ĐẸP:\n" +
    "   - Dùng thẻ <b>...</b> để in đậm tiêu đề và số liệu quan trọng. TUYỆT ĐỐI KHÔNG DÙNG dấu **!\n" +
    "   - Dùng dấu • để gạch đầu dòng danh sách.\n" +
    "   - Trình bày rõ ràng: Chi tiết từng công ty/tài liệu ➔ Cuối cùng ghi rõ dòng <b>🔥 TỔNG CỘNG VỐN ĐÃ GÓP:</b> ... VNĐ (tương đương ... USD).\n" +
    "4. TRÍCH XUẤT NGUYÊN BẢN CHÍNH XÁC 100%: Ghi rõ số liệu lấy từ từng file tài liệu nào để đảm bảo tính minh bạch.\n" +
    "5. QUY TẮC CẤM BỊA ĐẶT THÔNG TIN: Nếu bạn không biết câu trả lời hoặc không tìm thấy dữ liệu trong các tài liệu được cung cấp, chỉ cần nói rằng bạn không biết, đừng cố bịa ra câu trả lời cho tôi.\n\n";


  var parts = [];

  for (var f = 0; f < selectedFiles.length; f++) {
    var fItem = selectedFiles[f];
    var content = extractFileContent(fItem.id);

    parts.push({ text: "\n=== NỘI DUNG TÀI LIỆU " + (f + 1) + ": " + fItem.name + " ===\n" });

    if (content && typeof content === "object" && content.isPdfBlob) {
      parts.push({ inline_data: { mime_type: content.mimeType, data: content.base64Data } });
    } else if (typeof content === "string" && content.length > 0) {
      parts.push({ text: content.substring(0, 20000) });
    } else {
      parts.push({ text: "File: " + fItem.name });
    }
  }

  parts.push({ text: prompt });

  var payload = { contents: [{ parts: parts }] };

  var modelsToTry = ["gemini-3.1-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (var m = 0; m < modelsToTry.length; m++) {
    var modelName = modelsToTry[m];
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + API_KEY;
    try {
      var response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() === 200) {
        var json = JSON.parse(response.getContentText());
        var answerText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (answerText && answerText.trim().length > 0) {
          return answerText.trim();
        }
      } else {
        Logger.log("multiDocumentFileQnA model " + modelName + " status: " + response.getResponseCode());
      }
    } catch (e) {
      Logger.log("multiDocumentFileQnA fetch error: " + e.message);
    }
  }
  return null;
}

function formatMarkdownToGoogleChatHtml(text) {
  if (!text) return "";
  var formatted = text;

  // 1. Chuyển Markdown **in đậm** thành HTML <b>in đậm</b>
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");

  // 2. Chuyển Markdown * gạch đầu dòng hoặc - gạch đầu dòng thành • gạch đầu dòng
  formatted = formatted.replace(/^\s*[\*\-]\s+/gm, "• ");

  // 3. Chuyển *chữ nghiêng* thành <i>chữ nghiêng</i>
  formatted = formatted.replace(/(^|\s)\*([^\*]+)\*(\s|$)/g, "$1<i>$2</i>$3");

  // 4. Chuyển xuống dòng \n thành <br>
  formatted = formatted.replace(/\n/g, "<br>");

  return formatted;
}

function answerQuestionWithFileContent(userQuestion, fileItem) {
  var fileId = fileItem.id;
  var fileName = fileItem.name;

  var content = extractFileContent(fileId);

  var API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!API_KEY) return null;

  var prompt = "Bạn là trợ lý AI cao cấp 200 AI (phân tích dữ liệu doanh nghiệp tập đoàn ADD / VPA / AGB / ADC / ASG / TYM VINA / Worksmate).\n" +
    "Người dùng đang đặt câu hỏi: \"" + userQuestion + "\".\n" +
    "Nhiệm vụ của bạn là đọc toàn bộ NỘI DUNG TÀI LIỆU (" + fileName + ") dưới đây và thực hiện suy luận logic thông minh, chính xác 100% để trả lời đúng trọng tâm người dùng.\n\n" +
    "QUY TẮC CỰC KỲ NGHIÊM NGẶT KHI NỘI DUNG TÀI LIỆU KHÔNG CHỨA THÔNG TIN ĐƯỢC HỎI:\n" +
    "1. Nếu người dùng hỏi thông tin liên quan đến một cá nhân/dự án/đối tượng cụ thể (ví dụ: 'Lê Ngọc Quỳnh', 'nghỉ phép của X', 'hợp đồng của Y') mà NỘI DUNG TÀI LIỆU KHÔNG CHỨA thông tin về cá nhân/đối tượng đó:\n" +
    "   - BẮT BUỘC chỉ trả về duy nhất cụm từ đặc biệt: 'KHONG_TIM_THAY_THONG_TIN: Tôi đã rà soát tài liệu \"" + fileName + "\" nhưng không tìm thấy thông tin liên quan đến đối tượng được hỏi trong tài liệu này.'\n" +
    "   - TUYỆT ĐỐI CẤM KHÔNG ĐƯỢC tự ý liệt kê các danh sách thành viên, cổ đông, hoặc thông tin cá nhân của người khác (như Đặng Đình Thuyết, Son Min Chang...) có trong tài liệu khi người dùng KHÔNG HỎI về họ!\n" +
    "   - TUYỆT ĐỐI KHÔNG ĐƯỢC trả lời thông tin lệch chủ đề hoặc tự bịa ra thông tin cho người dùng!\n" +
    "2. HIỂU CÂU HỎI PHỨC TẠP, HẾT HẠN & THỜI HẠN:\n" +
    "   - Phân tích linh hoạt các câu hỏi về thời hạn, hết hạn, hiệu lực, ngày cấp, danh sách cổ đông, vốn điều lệ, địa chỉ trụ sở.\n" +
    "   - NẾU HỎI VỀ NGÀY HẾT HẠN / THỜI HẠN GIẤY PHÉP (IRC, Hợp đồng, Giấy phép lao động...):\n" +
    "     * Trích xuất chính xác Ngày cấp, Ngày đăng ký lần đầu/thay đổi và Thời hạn hoạt động của giấy phép/dự án (ví dụ: 10 năm, 20 năm, 50 năm).\n" +
    "     * TÍNH TOÁN NGÀY HẾT HẠN CHÍNH XÁC (ví dụ: Ngày cấp 15/06/2018 + thời hạn 10 năm ➔ Ngày hết hạn là 15/06/2028).\n" +
    "     * TÍNH TOÁN VÀ ĐÁNH GIÁ TRẠNG THÁI HIỆU LỰC (So sánh với thời điểm hiện tại năm 2026 ➔ Ghi rõ Còn hiệu lực bao nhiêu năm/tháng nữa hay đã hết hạn).\n" +
    "     * Nếu văn bản có giá trị vô thời hạn (như Đăng ký doanh nghiệp ERC): Báo rõ văn bản có giá trị vô thời hạn.\n" +
    "   - Nếu người dùng hỏi về 'thành viên góp vốn' hoặc 'cổ đông': BẮT BUỘC liệt kê ĐẦY ĐỦ từng cá nhân/tổ chức, Số tiền góp vốn (VNĐ/USD) và Tỷ lệ phần trăm (%) sở hữu tương ứng.\n" +
    "3. NGÔN NGỮ PHẢN HỒI (STRICT LANGUAGE MATCHING):\n" +
    "   - Tự động phát hiện ngôn ngữ câu hỏi: Tiếng Việt -> Trả lời Tiếng Việt; Tiếng Hàn (한국어) -> Trả lời 100% Tiếng Hàn; Tiếng Anh -> Trả lời Tiếng Anh.\n" +
    "4. ĐỊNH DẠNG HTML GOOGLE CHAT CHUẨN ĐẸP:\n" +
    "   - Dùng thẻ <b>...</b> để in đậm tiêu đề và thông tin quan trọng (Ví dụ: <b>📅 NGÀY HẾT HẠN:</b> ..., <b>⏳ TRẠNG THÁI:</b> ...). TUYỆT ĐỐI KHÔNG DÙNG dấu **!\n" +
    "   - Dùng dấu • để gạch đầu dòng danh sách (KHÔNG DÙNG dấu * hoặc -).\n" +
    "5. ĐỘ CHÍNH XÁC NGUYÊN BẢN & QUY TẮC CẤM BỊA ĐẶT THÔNG TIN:\n" +
    "   - Trích xuất đúng 100% số liệu, ngày tháng, tên người từ tài liệu.\n" +
    "   - Nếu bạn không biết câu trả lời hoặc không tìm thấy dữ liệu trong tài liệu, chỉ cần nói rằng bạn không biết, đừng cố bịa ra câu trả lời cho tôi.\n\n";

  var payload;
  if (content && typeof content === "object" && content.isPdfBlob) {
    payload = {
      contents: [{
        parts: [
          { inline_data: { mime_type: content.mimeType, data: content.base64Data } },
          { text: prompt }
        ]
      }]
    };
  } else if (typeof content === "string" && content.length > 0) {
    payload = {
      contents: [{
        parts: [{ text: prompt + "NỘI DUNG TÀI LIỆU:\n" + content.substring(0, 40000) }]
      }]
    };
  } else {
    payload = {
      contents: [{
        parts: [{ text: prompt + "Tên tài liệu: " + fileName }]
      }]
    };
  }

  // Sử dụng các model Multimodal chính thức hỗ trợ đọc PDF Base64
  var modelsToTry = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (var m = 0; m < modelsToTry.length; m++) {
    var modelName = modelsToTry[m];
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + API_KEY;
    try {
      var response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() === 200) {
        var json = JSON.parse(response.getContentText());
        var answerText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (answerText && answerText.trim().length > 0) {
          return answerText.trim();
        }
      } else {
        Logger.log("answerQuestionWithFileContent model " + modelName + " status: " + response.getResponseCode() + " resp: " + response.getContentText());
      }
    } catch (e) {
      Logger.log("answerQuestionWithFileContent fetch error: " + e.message);
    }
  }
  return null;
}

function buildFileQnACard(senderName, searchQuery, fileItem, aiAnswerText) {
  var widgets = [];

  widgets.push({
    textParagraph: {
      text: "💡 <b>TRÍCH XUẤT THÔNG TIN TÀI LIỆU</b> (Cho <b>" + senderName + "</b>):"
    }
  });

  var formattedAnswer = formatMarkdownToGoogleChatHtml(aiAnswerText);
  widgets.push({
    textParagraph: {
      text: formattedAnswer
    }
  });

  var dateStr = formatDateShort(fileItem.lastUpdated);
  var updateLabel = dateStr ? (" <i>(Cập nhật: " + dateStr + ")</i>") : "";
  var pFolder = fileItem.parentFolderName ? (" <i>[" + fileItem.parentFolderName + "]</i>") : "";

  widgets.push({
    textParagraph: {
      text: "📄 <i>Nguồn tài liệu: <b>" + fileItem.name + "</b>" + updateLabel + pFolder + "</i>"
    }
  });

  widgets.push({
    buttonList: {
      buttons: [{
        text: "🔗 Mở File tài liệu gốc",
        onClick: { openLink: { url: fileItem.url } },
        color: { red: 0.13, green: 0.69, blue: 0.31, alpha: 1 }
      }]
    }
  });

  return {
    cardsV2: [{
      cardId: "fileQnAResultCard",
      card: {
        header: {
          title: "🔎 Trích xuất thông tin AI",
          subtitle: "Dựa trên file: " + fileItem.name,
          imageType: "CIRCLE"
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

function isAuthorizedForInfoExtraction(userEmail, userName) {
  var emailLower = (userEmail || "").toLowerCase().trim();
  var nameLower = (userName || "").toLowerCase().trim();

  var ALLOWED_EMAILS = [
    "boss@add-group.net", "800@add-group.net", "ntttrang@planadd.com",
    "tmtam@add-group.net", "tvluat@add-group.net", "anhdd@add-group.net", "tientt@add-group.net"
  ];
  for (var w = 0; w < ALLOWED_EMAILS.length; w++) {
    if (emailLower === ALLOWED_EMAILS[w]) return true;
  }

  // Sếp lớn, Tô Vũ Luật, Team 200 & Tài khoản 800@add-group.net / ADD IT luôn có TOÀN QUYỀN TRUY CẬP
  if (emailLower.indexOf("800@") !== -1 || emailLower.indexOf("boss@") !== -1 ||
    emailLower.indexOf("tvluat@") !== -1 || emailLower.indexOf("luat") !== -1 ||
    nameLower.indexOf("luật") !== -1 || nameLower.indexOf("duy anh") !== -1 ||
    nameLower.indexOf("thủy tiên") !== -1 || nameLower.indexOf("tiên") !== -1 ||
    nameLower.indexOf("trang") !== -1 || nameLower.indexOf("tâm") !== -1 ||
    nameLower.indexOf("son") !== -1 || nameLower.indexOf("add it") !== -1 || nameLower.indexOf("800") !== -1) {
    return true;
  }

  var cacheKey = "AUTH_EXTRACTION_" + removeAccents(emailLower || nameLower).replace(/[^a-z0-9]/g, "_");
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached !== null) return cached === "true";
  } catch (ce) { }

  try {
    var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StaffInformation');
    if (!sheet) return true;

    var data = sheet.getDataRange().getValues();

    for (var r = 1; r < data.length; r++) {
      var rowEmail = String(data[r][11] || "").toLowerCase().trim();
      var rowName = String(data[r][1] || "").toLowerCase().trim();
      var rowNick = String(data[r][2] || "").toLowerCase().trim();
      var rowDiv = String(data[r][10] || "").trim(); // "000", "200", "300", "500"...
      var rowStaffId = String(data[r][0] || "").trim();

      var isMatch = (emailLower && rowEmail && emailLower === rowEmail) ||
        (nameLower && rowName && (nameLower.indexOf(rowName) !== -1 || rowName.indexOf(nameLower) !== -1)) ||
        (nameLower && rowNick && nameLower.indexOf(rowNick) !== -1);

      if (isMatch) {
        var isAllowed = (rowDiv === "000" || rowDiv === "200" || rowDiv === "000-200" ||
          rowStaffId.indexOf("000") !== -1 || rowStaffId.indexOf("200") !== -1 ||
          rowNick.indexOf("000") !== -1 || rowNick.indexOf("200") !== -1 ||
          rowEmail.indexOf("800@") !== -1 || rowEmail.indexOf("boss@") !== -1 || rowEmail.indexOf("tvluat@") !== -1);
        try { CacheService.getScriptCache().put(cacheKey, isAllowed ? "true" : "false", 600); } catch (e) { }
        return isAllowed;
      }
    }
  } catch (e) {
    Logger.log("isAuthorizedForInfoExtraction error: " + e.toString());
  }

  return false;
}

function buildPermissionDeniedCard(senderName) {
  var widgets = [
    {
      textParagraph: {
        text: "🚫 <b>THÔNG BÁO GIỚI HẠN QUYỀN TRUY CẬP</b> (Cho <b>" + senderName + "</b>):"
      }
    },
    {
      textParagraph: {
        text: "Xin lỗi <b>" + senderName + "</b>! Tính năng trích xuất thông tin chi tiết nội dung văn bản pháp lý & doanh nghiệp hiện tại <b>chỉ dành riêng cho Ban Giám Đốc (Bộ phận 000) và Phòng Hành chính (Bộ phận 200)</b>.<br><br>Vui lòng liên hệ Trưởng bộ phận hoặc Ban Giám Đốc nếu anh/chị cần trích xuất thông tin này!"
      }
    }
  ];

  return {
    cardsV2: [{
      cardId: "permissionDeniedCard",
      card: {
        header: {
          title: "🔒 Giới hạn quyền truy cập thông tin",
          subtitle: "Dành cho " + senderName,
          imageType: "CIRCLE"
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

function handleLinkRequest(text, senderName, message) {
  var searchQuery = extractSearchKeywordByGemini(text);
  if (!searchQuery || searchQuery === "KHONG_RO") {
    return buildGuideCard(senderName);
  }

  var results = searchInDrive(searchQuery, text);
  if (!results || results.length === 0) {
    return buildNotFoundCard(senderName, searchQuery);
  }

  // NẾU NGUỜI DÙNG HỎI TRÍCH XUẤT THÔNG TIN TRONG FILE (Mã số doanh nghiệp, Vốn điều lệ, Cổ đông...):
  if (isInfoExtractionRequest(text)) {
    // 🔒 PHÂN QUYỀN CHẶT CHẼ: CHỈ BAN GIÁM ĐỐC (000) VÀ PHÒNG HÀNH CHÍNH (200) ĐƯỢC HỎI
    var userEmail = (message && message.user && message.user.email) ? message.user.email : ((message && message.sender && message.sender.email) ? message.sender.email : "");
    var isAuthorized = isAuthorizedForInfoExtraction(userEmail, senderName);

    if (!isAuthorized) {
      return buildPermissionDeniedCard(senderName);
    }

    // 🧮 XỬ LÝ TÍNH TOÁN & THÔNG TIN ĐA TÀI LIỆU / ĐA CÔNG TY (MULTI-DOCUMENT CALCULATIONS)
    var mentionedCompanies = extractMentionedCompanies(text);
    if (isCalculationOrMultiDocRequest(text) && mentionedCompanies.length > 0) {
      var multiFiles = [];
      var seenIds = {};

      for (var c = 0; c < mentionedCompanies.length; c++) {
        var compName = mentionedCompanies[c];
        // Tìm file pháp lý 211.2 cho từng công ty với query sạch để cách ly hoàn toàn tên công ty
        var compResults = searchInDrive("211.2 " + compName, "211.2 " + compName);
        if (compResults && compResults.length > 0) {
          for (var r = 0; r < compResults.length; r++) {
            var item = compResults[r];
            if (!item.isFolder && !seenIds[item.id]) {
              seenIds[item.id] = true;
              multiFiles.push(item);
              if (multiFiles.length >= 6) break; // Lấy tối đa 6 file để nạp AI
            }
          }
        }
      }

      if (multiFiles.length > 1) {
        var calculatedAiAnswer = multiDocumentFileQnA(text, multiFiles);
        if (calculatedAiAnswer) {
          // Bắt tín hiệu không tìm thấy từ multiDoc
          if (calculatedAiAnswer.indexOf("KHONG_TIM_THAY_THONG_TIN") !== -1) {
            var cleanMultiMsg = calculatedAiAnswer.replace("KHONG_TIM_THAY_THONG_TIN:", "").trim();
            return { "text": "🔍 " + cleanMultiMsg };
          }
          var multiDocItem = {
            name: multiFiles.map(function (f) { return f.name; }).join(", "),
            url: multiFiles[0].url
          };
          return buildFileQnACard(senderName, searchQuery, multiDocItem, calculatedAiAnswer);
        }
      }
    }

    var fileItems = results.filter(function (r) { return !r.isFolder; });
    if (fileItems.length > 0) {
      fileItems.sort(function (a, b) {
        return (b.relevanceScore || 0) - (a.relevanceScore || 0);
      });
      var bestFile = fileItems[0];
      var aiAnswer = answerQuestionWithFileContent(text, bestFile);
      if (!aiAnswer) {
        // Dự phòng: Nếu nạp PDF dung lượng lớn làm Gemini trả về null, tự động chuyển câu hỏi cho AI trả lời từ tên file
        aiAnswer = answerQuestionWithFileContent(text, { id: bestFile.id, name: bestFile.name });
      }

      if (aiAnswer) {
        // Nếu AI trả về tín hiệu KHONG_TIM_THAY_THONG_TIN hoặc xác nhận không có thông tin đối tượng trong tài liệu
        if (aiAnswer.indexOf("KHONG_TIM_THAY_THONG_TIN") !== -1) {
          var cleanMsg = aiAnswer.replace("KHONG_TIM_THAY_THONG_TIN:", "").trim();
          return { "text": "🔍 " + cleanMsg };
        }

        var lowerAnswer = aiAnswer.toLowerCase();
        if (lowerAnswer.indexOf("không tìm thấy") !== -1 && (lowerAnswer.indexOf("không có thông tin") !== -1 || lowerAnswer.indexOf("không có dữ liệu") !== -1)) {
          return { "text": "🔍 Tôi đã kiểm tra các file tài liệu liên quan nhưng **không tìm thấy thông tin về câu hỏi của bạn**. Anh/chị vui lòng kiểm tra lại tên nhân sự / hồ sơ hoặc liên hệ Phòng 200 để được hỗ trợ!" };
        }

        return buildFileQnACard(senderName, searchQuery, bestFile, aiAnswer);
      }
    }
  }

  return buildResultCard(senderName, searchQuery, results, text);
}

function extractSearchKeywordByGemini(userMessage) {
  var lower = userMessage.toLowerCase();

  // 1. Thử trích xuất bằng AI Gemini
  var prompt = "Người dùng đang hỏi trong Google Chat: \"" + userMessage + "\". " +
    "Hãy xác định loại tài liệu, mã thư mục và tên công ty mà họ tìm kiếm trong Google Drive.\n" +
    "CẤU TRÚC THƯ MỤC GỐC: 200. Administration ADC, gồm các thư mục con:\n" +
    "- 210: Documents Management - Quản lý văn bản tài liệu (gồm 211 đến 219):\n" +
    "  + 211: Company Legal Documents - Giấy tờ pháp lý công ty (chứa thư mục các công ty: ADC, ADD, AGB, ASG, TYM VINA & CESS, VPA, Worksmate)\n" +
    "    * 211.1: Điều lệ công ty / Quy định / Quy chế / 정관\n" +
    "    * 211.2: ERC, IRC, Đăng ký kinh doanh, ĐKKD, Chứng nhận đầu tư, Giấy phép kinh doanh / Business Registration\n" +
    "    * 211.4: Giấy chứng nhận đăng ký nhãn hiệu / Brand name\n" +
    "    * 211.5: Đăng ký mạng lưới đấu thầu Quốc gia / Online bidding\n" +
    "    * 211.6: Các quyết định, bổ nhiệm / Decisions\n" +
    "    * 211.7: Sổ đỏ, GPXD, PCCC, Giấy phép xây dựng / Redbook\n" +
    "    * 211.9: Others / Khác\n" +
    "  + 212: Reporting contract to Goverment - Báo cáo văn phòng nhà thầu\n" +
    "  + 213: Passport, Visa, Work permit, Resident card - Hộ chiếu, Thị thực, Lý lịch tư pháp, Giấy phép lao động\n" +
    "  + 214: Announcement - Thông báo hành chính\n" +
    "  + 215: Send, Receive Official Letter - Công văn ra vào\n" +
    "  + 216: Working Handover - Biên bản Bàn giao công việc\n" +
    "  + 217: Contract managing - Quản lý hợp đồng\n" +
    "  + 218: ADD form - Mẫu văn bản công ty\n" +
    "  + 219: Capacity profile by Goverment - Hồ sơ năng lực theo quy định BXD\n" +
    "- 220: Asset management - Quản lý tài sản\n" +
    "- 230: Human resources - Quản lý nhân sự\n" +
    "- 240: Legal - Pháp lý, pháp chế\n" +
    "- 250: IT & technical support - Quản lý IT, hỗ trợ kỹ thuật\n" +
    "- 260: Treasurer - Công tác thủ quỹ\n" +
    "- 270: Office services - Dịch vụ văn phòng\n" +
    "- 280: Stamps management - Quản lý con dấu, Chữ ký\n" +
    "- 290: Others - Công tác khác\n\n" +
    "CÁC CÔNG TY THÀNH VIÊN VÀ CHI NHÁNH: ADC, ADD, AGB, ASG, TYM VINA & CESS, VPA (bao gồm VPA HCM, VPA HN), Worksmate, ADD Group, Se ADD, KPA, GEO ADD, ADD CON.\n\n" +
    "QUY TẮC BẮT BUỘC TRẢ VỀ:\n" +
    "1. Nếu người dùng nêu rõ chi nhánh (HCM, Hà Nội, HN, Đà Nẵng...), hãy giữ nguyên tên chi nhánh (Ví dụ: 'VPA HCM', 'VPA HN').\n" +
    "2. 'ERC', 'IRC', 'đăng ký kinh doanh', 'đầu tư', 'giấy phép kinh doanh', 'mã số thuế', 'msdn', 'mst', 'vốn', 'vốn điều lệ', 'người đại diện', 'đại diện pháp luật' -> mã 211.2\n" +
    "3. 'điều lệ', 'quy định', 'quy chế' -> mã 211.1\n" +
    "4. 'sổ đỏ', 'gpxd', 'pccc', 'giấy phép xây dựng' -> mã 211.7\n" +
    "5. 'nhãn hiệu', 'brand' -> mã 211.4\n" +
    "6. 'đấu thầu' -> mã 211.5\n" +
    "7. 'quyết định', 'bổ nhiệm' -> mã 211.6\n" +
    "8. 'hộ chiếu', 'passport', 'visa', 'thị thực', 'work permit', 'giấy phép lao động', 'thẻ tạm trú' -> mã 213\n" +
    "9. 'thông báo' -> mã 214\n" +
    "10. 'công văn' -> mã 215\n" +
    "11. 'bàn giao' -> mã 216\n" +
    "12. 'hợp đồng' -> mã 217\n" +
    "13. 'mẫu văn bản', 'form' -> mã 218\n" +
    "14. 'hồ sơ năng lực' -> mã 219\n" +
    "15. 'tài sản', 'asset' -> mã 220\n" +
    "16. 'nhân sự', 'human resources', 'HR' -> mã 230\n" +
    "17. 'pháp lý', 'pháp chế', 'legal' -> mã 240\n" +
    "18. 'IT', 'kỹ thuật', 'technical' -> mã 250\n" +
    "19. 'thủ quỹ', 'treasurer' -> mã 260\n" +
    "20. 'văn phòng', 'office' -> mã 270\n" +
    "21. 'con dấu', 'stamp', 'chữ ký' -> mã 280\n" +
    "Cấu trúc trả về: '[MÃ THƯ MỤC] [TÊN CÔNG TY VÀ CHI NHÁNH]' (Ví dụ: '211.2 VPA HCM', '211.2 AGB', '211.1 VPA', '213', '217', '230').\n" +
    "Nếu không xác định được hoặc không biết câu trả lời, chỉ cần trả về 'KHONG_RO', đừng cố bịa ra kết quả cho tôi.\n" +
    "Chỉ trả về đúng chuỗi kết quả ngắn gọn, không thêm bất kỳ văn bản nào khác.";

  var result = sendtoGeminiForLink(prompt);
  if (result && result.trim() !== "" && result.trim() !== "KHONG_RO") {
    return result.trim().replace(/['"]/g, "");
  }

  // 2. ⭐ BỘ LỌC DỰ PHÒNG THÔNG MINH (Rule-based Fallback)
  var compName = extractCompanyName(lower);

  // ERC / IRC / Đăng ký kinh doanh / Đầu tư / ĐKKD / Mã số thuế / MST / MSDN / Vốn / Đại diện -> 211.2
  if (lower.indexOf("erc") !== -1 || lower.indexOf("irc") !== -1 || lower.indexOf("đăng ký kinh doanh") !== -1 || lower.indexOf("dkkd") !== -1 || lower.indexOf("đkkd") !== -1 || lower.indexOf("đầu tư") !== -1 || lower.indexOf("211.2") !== -1 || lower.indexOf("mã số thuế") !== -1 || lower.indexOf("mst") !== -1 || lower.indexOf("msdn") !== -1 || lower.indexOf("vốn") !== -1 || lower.indexOf("đại diện") !== -1) {
    return compName ? ("211.2 " + compName) : "211.2";
  }
  // Điều lệ / Quy định / Quy chế -> 211.1
  if (lower.indexOf("điều lệ") !== -1 || lower.indexOf("quy định") !== -1 || lower.indexOf("quy chế") !== -1 || lower.indexOf("211.1") !== -1) {
    return compName ? ("211.1 " + compName) : "211.1";
  }
  // Sổ đỏ / Đất / GPXD / PCCC -> 211.7
  if (lower.indexOf("sổ đỏ") !== -1 || lower.indexOf("quyền sử dụng đất") !== -1 || lower.indexOf("gpxd") !== -1 || lower.indexOf("pccc") !== -1 || lower.indexOf("211.7") !== -1) {
    return compName ? ("211.7 " + compName) : "211.7";
  }
  // Nhãn hiệu -> 211.4
  if (lower.indexOf("nhãn hiệu") !== -1 || lower.indexOf("brand") !== -1 || lower.indexOf("211.4") !== -1) {
    return compName ? ("211.4 " + compName) : "211.4";
  }
  // Đấu thầu -> 211.5
  if (lower.indexOf("đấu thầu") !== -1 || lower.indexOf("211.5") !== -1) {
    return "211.5";
  }
  // Quyết định / Bổ nhiệm -> 211.6
  if (lower.indexOf("quyết định") !== -1 || lower.indexOf("bổ nhiệm") !== -1 || lower.indexOf("211.6") !== -1) {
    return compName ? ("211.6 " + compName) : "211.6";
  }
  // Báo cáo nhà thầu -> 212
  if (lower.indexOf("212") !== -1 || lower.indexOf("báo cáo nhà thầu") !== -1 || lower.indexOf("reporting contract") !== -1) {
    return "212";
  }
  // Passport / Visa / Work permit -> 213
  if (lower.indexOf("213") !== -1 || lower.indexOf("passport") !== -1 || lower.indexOf("hộ chiếu") !== -1 || lower.indexOf("visa") !== -1 || lower.indexOf("work permit") !== -1 || lower.indexOf("giấy phép lao động") !== -1 || lower.indexOf("thẻ tạm trú") !== -1) {
    return "213";
  }
  // Thông báo hành chính -> 214
  if (lower.indexOf("214") !== -1 || lower.indexOf("thông báo") !== -1 || lower.indexOf("announcement") !== -1) {
    return "214";
  }
  // Công văn -> 215
  if (lower.indexOf("215") !== -1 || lower.indexOf("công văn") !== -1 || lower.indexOf("official letter") !== -1) {
    return "215";
  }
  // Bàn giao -> 216
  if (lower.indexOf("216") !== -1 || lower.indexOf("bàn giao") !== -1 || lower.indexOf("handover") !== -1) {
    return "216";
  }
  // Hợp đồng -> 217
  if (lower.indexOf("217") !== -1 || lower.indexOf("hợp đồng") !== -1 || lower.indexOf("contract") !== -1) {
    return "217";
  }
  // Mẫu văn bản -> 218
  if (lower.indexOf("218") !== -1 || lower.indexOf("mẫu văn bản") !== -1 || lower.indexOf("add form") !== -1) {
    return "218";
  }
  // Hồ sơ năng lực -> 219
  if (lower.indexOf("219") !== -1 || lower.indexOf("hồ sơ năng lực") !== -1 || lower.indexOf("capacity profile") !== -1) {
    return "219";
  }
  // Tài sản -> 220
  if (lower.indexOf("tài sản") !== -1 || lower.indexOf("asset") !== -1 || lower.indexOf("220") !== -1) {
    return "220";
  }
  // Nhân sự -> 230
  if (lower.indexOf("nhân sự") !== -1 || lower.indexOf("human resources") !== -1 || lower.indexOf("230") !== -1) {
    return "230";
  }
  // Pháp lý -> 240
  if (lower.indexOf("pháp lý") !== -1 || lower.indexOf("pháp chế") !== -1 || lower.indexOf("legal") !== -1 || lower.indexOf("240") !== -1) {
    return "240";
  }
  // IT -> 250
  if (lower.indexOf("250") !== -1 || lower.indexOf("kỹ thuật") !== -1 || lower.indexOf("technical") !== -1) {
    return "250";
  }
  // Thủ quỹ -> 260
  if (lower.indexOf("thủ quỹ") !== -1 || lower.indexOf("treasurer") !== -1 || lower.indexOf("260") !== -1) {
    return "260";
  }
  // Văn phòng -> 270
  if (lower.indexOf("270") !== -1 || lower.indexOf("office services") !== -1) {
    return "270";
  }
  // Con dấu / Chữ ký -> 280
  if (lower.indexOf("280") !== -1 || lower.indexOf("con dấu") !== -1 || lower.indexOf("chữ ký") !== -1 || lower.indexOf("stamp") !== -1) {
    return "280";
  }
  // Others -> 290
  if (lower.indexOf("290") !== -1) {
    return "290";
  }

  return "KHONG_RO";
}

function extractCompanyName(text) {
  var t = text.toLowerCase();

  // 1. Kiểm tra Công ty kèm Chi nhánh (HCM, Hà Nội, HN...)
  if (t.indexOf("vpa hcm") !== -1 || t.indexOf("vpa-hcm") !== -1 || t.indexOf("vpa hồ chí minh") !== -1 || t.indexOf("vpa sai gon") !== -1 || t.indexOf("vpa sài gòn") !== -1) return "VPA HCM";
  if (t.indexOf("add hcm") !== -1 || t.indexOf("add-hcm") !== -1) return "ADD HCM";
  if (t.indexOf("adc hcm") !== -1) return "ADC HCM";
  if (t.indexOf("asg hcm") !== -1) return "ASG HCM";

  if (t.indexOf("vpa hn") !== -1 || t.indexOf("vpa hà nội") !== -1) return "VPA HN";
  if (t.indexOf("add hn") !== -1 || t.indexOf("add hà nội") !== -1) return "ADD HN";

  // 2. Tên Công ty gốc
  if (t.indexOf("add group") !== -1 || t.indexOf("add-group") !== -1 || t.indexOf("addgroup") !== -1) return "ADD group";
  if (t.indexOf("adc") !== -1) return "ADC";
  if (t.indexOf("agb") !== -1) return "AGB";
  if (t.indexOf("asg") !== -1) return "ASG";
  if (t.indexOf("vpa") !== -1) return "VPA";
  if (t.indexOf("tym") !== -1) return "TYM VINA";
  if (t.indexOf("worksmate") !== -1) return "Worksmate";
  if (t.indexOf("se add") !== -1 || t.indexOf("seadd") !== -1) return "Se ADD";
  if (t.indexOf("kpa") !== -1) return "KPA";
  if (t.indexOf("geo add") !== -1 || t.indexOf("geoadd") !== -1) return "GEO ADD";
  if (t.indexOf("add con") !== -1 || t.indexOf("addcon") !== -1) return "ADD CON";
  if (t.indexOf("add") !== -1) return "ADD";
  return "";
}

function sendtoGeminiForLink(prompt) {
  var API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!API_KEY) {
    Logger.log("GEMINI_API_KEY chưa được cấu hình.");
    return null;
  }

  var payload = { contents: [{ parts: [{ text: prompt }] }] };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  // Thử lần lượt các model chuẩn của Google Gemini API
  var modelsToTry = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];

  for (var m = 0; m < modelsToTry.length; m++) {
    var modelName = modelsToTry[m];
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + API_KEY;

    try {
      var response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() === 200) {
        var json = JSON.parse(response.getContentText());
        var text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } else {
        Logger.log("sendtoGeminiForLink model " + modelName + " HTTP " + response.getResponseCode() + ": " + response.getContentText());
      }
    } catch (e) {
      Logger.log("sendtoGeminiForLink model " + modelName + " exception: " + e.toString());
    }
  }

  return null;
}

function getSubFolders() {
  var subFoldersList = [];
  try {
    var parentFolder = DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);
    var folders = parentFolder.getFolders();
    while (folders && folders.hasNext()) {
      try {
        var folder = folders.next();
        if (!folder) continue;
        subFoldersList.push({
          name: folder.getName(),
          id: folder.getId(),
          url: folder.getUrl()
        });
      } catch (fe) {
        Logger.log("getSubFolders skip folder: " + fe.message);
      }
    }
    subFoldersList.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  } catch (e) {
    Logger.log("getSubFolders error: " + e.toString());
  }
  return subFoldersList;
}

function extractFileVersionScore(fileName) {
  var score = 0;
  var name = fileName.toLowerCase();

  // 1. Trích xuất năm độc lập (ví dụ 2025 -> +2500 điểm, 2021 -> +2100 điểm, dùng \b để tránh khớp nhầm chuỗi ngày dính liền như 22052026)
  var yearMatch = name.match(/\b20[1-3][0-9]\b/);
  if (yearMatch) {
    var year = parseInt(yearMatch[0], 10);
    score += (year - 2000) * 100;
  }

  // 2. Trích xuất số phiên bản (ví dụ 5th -> +50 điểm, 4th -> +40 điểm, 3rd -> +30 điểm)
  var verMatch = name.match(/(\d+)(?:st|nd|rd|th|\s*th|\s*lần|\s*lan|\s*v)/i) || name.match(/(?:v|lần|lan)\s*(\d+)/i);
  if (verMatch) {
    var ver = parseInt(verMatch[1], 10);
    if (ver > 0 && ver < 50) score += ver * 10;
  }

  return score;
}

function calculateQueryCoverageScore(queryStr, fileNameStr) {
  if (!queryStr || !fileNameStr) return 0;
  var qClean = removeAccents(queryStr.toLowerCase()).replace(/[^a-z0-9]/g, " ").trim();
  var fClean = removeAccents(fileNameStr.toLowerCase()).replace(/[^a-z0-9]/g, " ").trim();

  var stopWords = ["cho", "toi", "thong", "tin", "cua", "ve", "tap", "tin", "file", "moi", "nhat", "ngay", "bay", "cac", "trong", "thang", "nam", "giup", "xem"];
  var qTokens = qClean.split(/\s+/).filter(function (t) { return t.length >= 1 && stopWords.indexOf(t) === -1; });

  if (qTokens.length === 0) return 0;

  var uniqueTokens = [];
  for (var u = 0; u < qTokens.length; u++) {
    if (uniqueTokens.indexOf(qTokens[u]) === -1) uniqueTokens.push(qTokens[u]);
  }

  var matchCount = 0;
  for (var i = 0; i < uniqueTokens.length; i++) {
    if (fClean.indexOf(uniqueTokens[i]) !== -1) {
      matchCount++;
    }
  }

  var ratio = matchCount / uniqueTokens.length;
  if (ratio === 1.0) {
    return 10000; // 100% khớp tất cả từ khóa ➔ +10,000 điểm ưu tiên cao nhất tuyệt đối!
  } else if (ratio >= 0.75) {
    return 5000;
  } else if (ratio >= 0.5) {
    return 2000;
  }
  return matchCount * 200;
}

function searchInDrive(keyword, rawText) {
  if (!keyword || keyword === "KHONG_RO") return [];

  var rawQueryStr = (rawText || "").toLowerCase();
  var cacheKey = "DRIVE_SEARCH_V7_" + removeAccents((keyword + "_" + rawQueryStr).trim()).replace(/[^a-z0-9]/g, "_");
  try {
    var cachedJson = CacheService.getScriptCache().get(cacheKey);
    if (cachedJson) {
      return JSON.parse(cachedJson);
    }
  } catch (e) { }

  var results = [];
  var addedIds = {};

  try {
    var lowerQuery = keyword.toLowerCase().trim();
    var combinedQuery = lowerQuery + " " + rawQueryStr;
    // Ưu tiên 1: Extract tên công ty từ từ khóa tìm kiếm (keyword) trước
    var targetCompany = extractCompanyName(keyword);
    // Ưu tiên 2: Nếu keyword không chỉ định công ty cụ thể mới dùng câu hỏi nguyên bản
    if (!targetCompany && rawQueryStr) {
      targetCompany = extractCompanyName(rawQueryStr);
    }

    // 1. NẾU TÌM THEO CÔNG TY (AGB, VPA, ADC, ADD, ASG, TYM VINA, Worksmate...):
    // Quét trực tiếp Thư mục 211. Company Legal Documents (1oDhTJUEmdICreryjojxuMisUVXT09jPD)
    var LEGAL_211_FOLDER_ID = "1oDhTJUEmdICreryjojxuMisUVXT09jPD";
    var foundCompanyFolder = null;

    if (targetCompany) {
      // Lấy tên công ty gốc (ví dụ: "VPA HCM" -> "VPA", "ADD HCM" -> "ADD") để tìm đúng Thư mục trong 211
      var baseCompanyStr = targetCompany.split(" ")[0].toLowerCase();
      try {
        var legal211 = DriveApp.getFolderById(LEGAL_211_FOLDER_ID);
        var subFs = legal211.getFolders();
        while (subFs && subFs.hasNext()) {
          var subF = subFs.next();
          if (!subF) continue;
          var subFName = subF.getName();
          if (subFName.toLowerCase().indexOf(baseCompanyStr) !== -1) {
            foundCompanyFolder = subF;
            break;
          }
        }
      } catch (e211) {
        Logger.log("searchInDrive 211 error: " + e211.message);
      }
    }

    // Nếu tìm thấy Thư mục công ty trong 211 (Ví dụ Thư mục VPA / ADD / AGB):
    if (foundCompanyFolder) {
      var cId = foundCompanyFolder.getId();
      var cName = foundCompanyFolder.getName();

      // Thêm Thư mục công ty vào kết quả
      if (!addedIds[cId]) {
        addedIds[cId] = true;
        results.push({
          name: cName,
          url: foundCompanyFolder.getUrl(),
          mimeType: "📁 Thư mục (" + cName + ")",
          id: cId,
          isFolder: true,
          parentFolderName: "211. Company Legal Documents",
          lastUpdated: foundCompanyFolder.getLastUpdated ? foundCompanyFolder.getLastUpdated() : null,
          relevanceScore: 80,
          isOld: false
        });
      }

      // Quét tất cả file và folder con bên trong thư mục công ty này (VPA)
      getFilesFromFolderDeep(foundCompanyFolder, results, addedIds, 0, 5);
    }

    // 1.5. QUÉT THÊM THƯ MỤC VÉ MÁY BÀY (291. Quan ly cong tac - Air Ticket)
    try {
      var flightSheetsMap = getFlightSheetsMap();
      var cleanQueryNorm = removeAccents(combinedQuery.toLowerCase()).replace(/[^a-z0-9]/g, " ");
      var queryTokens = cleanQueryNorm.split(/\s+/).filter(function (t) { return t.length >= 2 && ["cho", "toi", "thong", "tin", "cua", "ve", "tap", "tin", "file", "moi", "nhat"].indexOf(t) === -1; });

      for (var yK in flightSheetsMap) {
        var yObj = flightSheetsMap[yK];
        if (yObj && yObj.monthlyFolders) {
          for (var mK in yObj.monthlyFolders) {
            var mFold = yObj.monthlyFolders[mK];
            if (mFold && mFold.files) {
              for (var mf = 0; mf < mFold.files.length; mf++) {
                var flItem = mFold.files[mf];
                if (!addedIds[flItem.id]) {
                  var flNameNorm = removeAccents(flItem.name.toLowerCase()).replace(/[^a-z0-9]/g, " ");
                  var flScore = 0;

                  for (var qt = 0; qt < queryTokens.length; qt++) {
                    if (flNameNorm.indexOf(queryTokens[qt]) !== -1) {
                      flScore += 200;
                    }
                  }

                  if (flScore > 0) {
                    addedIds[flItem.id] = true;
                    results.push({
                      name: flItem.name,
                      url: flItem.url,
                      mimeType: getMimeTypeLabel("application/pdf"),
                      id: flItem.id,
                      isFolder: false,
                      parentFolderName: mFold.name,
                      lastUpdated: new Date(),
                      relevanceScore: flScore + 600,
                      isOld: false
                    });
                  }
                }
              }
            }
          }
        }
      }
    } catch (errFlightSearch) {
      Logger.log("searchInDrive flight folder search error: " + errFlightSearch.message);
    }

    // 2. DÙNG DriveApp.searchFiles TRỰC TIẾP KHỚP TỪ KHÓA:
    var searchTerms = [];
    if (targetCompany) {
      var compParts = targetCompany.split(" ");
      for (var cp = 0; cp < compParts.length; cp++) {
        var cpTerm = compParts[cp].trim();
        if (cpTerm.length >= 2 && searchTerms.indexOf(cpTerm) === -1) {
          searchTerms.push(cpTerm);
        }
      }
    }
    if (/\berc\b/i.test(combinedQuery)) searchTerms.push("erc");
    if (/\birc\b/i.test(combinedQuery)) searchTerms.push("irc");
    if (combinedQuery.indexOf("điều lệ") !== -1) searchTerms.push("điều lệ");

    for (var st = 0; st < searchTerms.length; st++) {
      var term = searchTerms[st];
      if (!term || term.length < 2) continue;
      try {
        var fileQuery = "name contains '" + term.replace(/'/g, "\\'") + "' and trashed = false";
        var foundFiles = DriveApp.searchFiles(fileQuery);
        while (foundFiles && foundFiles.hasNext() && results.length < 35) {
          var file = foundFiles.next();
          if (!file) continue;
          var fileId = file.getId();
          if (!addedIds[fileId]) {
            addedIds[fileId] = true;
            results.push({
              name: file.getName(),
              url: file.getUrl(),
              mimeType: getMimeTypeLabel(file.getMimeType()),
              id: fileId,
              isFolder: false,
              parentFolderName: "Drive",
              lastUpdated: file.getLastUpdated(),
              relevanceScore: 10,
              isOld: false
            });
          }
        }
      } catch (eFile) {
        Logger.log("searchInDrive searchFiles error: " + eFile.message);
      }
    }

    // 3. STRICT FILTERING: LỌC BỎ HOÀN TOÀN LOẠI TÀI LIỆU KHÔNG KHỚP (Ví dụ: Hỏi ERC thì LỌC BỎ CHẾT IRC & Điều lệ)
    var isErcOnlyQuery = /\berc\b/i.test(combinedQuery) || lowerQuery.indexOf("211.2") !== -1;
    var isIrcOnlyQuery = /\birc\b/i.test(combinedQuery);
    var isDieuLeQuery = /điều lệ|quy định|quy chế|211\.1/i.test(combinedQuery);
    var isSoDoQuery = /sổ đỏ|gpxd|pccc|đất|211\.7/i.test(combinedQuery);

    if (isErcOnlyQuery && !isIrcOnlyQuery) {
      // Chỉ giữ lại file ERC / ĐKKD, LỌC BỎ HOÀN TOÀN IRC HOÀC ĐIỀU LỆ
      results = results.filter(function (item) {
        if (item.isFolder) return true;
        var nameLower = item.name.toLowerCase();
        var isErc = /\berc\b/i.test(nameLower) || nameLower.indexOf("đăng ký kinh doanh") !== -1 || nameLower.indexOf("đkkd") !== -1;
        var isIrc = /\birc\b/i.test(nameLower);
        return isErc && !isIrc;
      });
    } else if (isIrcOnlyQuery) {
      // Chỉ giữ lại file IRC, LỌC BỎ HOÀN TOÀN ERC
      results = results.filter(function (item) {
        if (item.isFolder) return true;
        var nameLower = item.name.toLowerCase();
        return /\birc\b/i.test(nameLower) && !/\berc\b/i.test(nameLower);
      });
    } else if (isDieuLeQuery) {
      // Chỉ giữ lại file Điều lệ / Quy định
      results = results.filter(function (item) {
        if (item.isFolder) return true;
        var nameLower = item.name.toLowerCase();
        return /điều lệ|quy định|quy chế/i.test(nameLower);
      });
    }

    // LỌC BỎ FILE ẢNH (JPG, JPEG, PNG, VNeID) KHI HỎI VĂN BẢN PHÁP LÝ (ERC, IRC, ĐIỀU LỆ...)
    if ((isErcOnlyQuery || isIrcOnlyQuery || isDieuLeQuery || isSoDoQuery) && !/ảnh|hình|image|photo|jpg|jpeg|png|vneid/i.test(combinedQuery)) {
      results = results.filter(function (item) {
        if (item.isFolder) return true;
        var nameLower = item.name.toLowerCase();
        var isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(nameLower) || nameLower.indexOf("vneid") !== -1;
        return !isImage;
      });
    }

    // 4. KIỂM TRA TỪ KHÓA CHI NHÁNH (HCM, HN, Hà Nội, Đà Nẵng...) ĐỂ CỘNG +1000 ĐIỂM ƯU TIÊN
    var branchMatch = combinedQuery.match(/\b(hcm|hồ chí minh|hn|hà nội|đà nẵng|dn|chi nhánh)\b/i);
    var branchKeyword = branchMatch ? branchMatch[1].toLowerCase() : "";

    for (var r = 0; r < results.length; r++) {
      var item = results[r];
      var itemNameLower = item.name.toLowerCase();
      var score = item.relevanceScore || 0;

      // TRỪ ĐIỂM NẶNG CHO FILE TRONG THƯ MỤC OLD / DRAFT
      if (item.isOld) {
        score -= 1000;
      }

      // Khớp tên công ty gốc (VPA, ADD, ADC...) trong file/folder name
      var baseCompany = targetCompany ? targetCompany.split(" ")[0].toLowerCase() : "";
      if (baseCompany && itemNameLower.indexOf(baseCompany) !== -1) {
        score += 50;
      }

      // KHỚP TỪ KHÓA CHI NHÁNH (CỘNG +1000 ĐIỂM NẾU FILE CÓ CHỨA HCM HOẶC HN)
      if (branchKeyword) {
        if (branchKeyword === "hcm" || branchKeyword === "hồ chí minh") {
          if (itemNameLower.indexOf("hcm") !== -1 || itemNameLower.indexOf("hồ chí minh") !== -1) {
            score += 1000; // Ưu tiên số 1 cho file chi nhánh HCM!
          }
        } else if (branchKeyword === "hn" || branchKeyword === "hà nội") {
          if (itemNameLower.indexOf("hn") !== -1 || itemNameLower.indexOf("hà nội") !== -1) {
            score += 1000;
          }
        } else if (itemNameLower.indexOf(branchKeyword) !== -1) {
          score += 800;
        }
      }

      if (isErcOnlyQuery && /\berc\b/i.test(itemNameLower)) score += 500;
      if (isIrcOnlyQuery && /\birc\b/i.test(itemNameLower)) score += 500;
      if (isDieuLeQuery && /điều lệ|quy định|quy chế/i.test(itemNameLower)) score += 500;
      if (isSoDoQuery && /sổ đỏ|gpxd|pccc/i.test(itemNameLower)) score += 500;

      // ƯU TIÊN VĂN BẢN PDF CHÍNH THỨC (+300 ĐIỂM)
      if (/\.pdf$/i.test(itemNameLower) || (item.mimeType && item.mimeType.indexOf("PDF") !== -1)) {
        score += 300;
      }

      // CỘNG ĐIỂM PHIÊN BẢN VÀ NĂM MỚI NHẤT (2025 > 2021, 5th > 4th > 3rd)
      score += extractFileVersionScore(item.name);

      // CỘNG ĐIỂM KHỚP CHÍNH XÁC TỪ KHÓA CÂU HỎI (100% MATCHING OVERLAP BONUS)
      score += calculateQueryCoverageScore(combinedQuery, item.name);

      // Trừ điểm mạnh nếu là file rác (điều hòa, nghiệm thu, vpp...)
      if (/điều hòa|nghiệm thu|bảo dưỡng|sửa chữa|vpp|chấm công/i.test(itemNameLower) && !isErcOnlyQuery) {
        score -= 1000;
      }

      item.relevanceScore = score;
    }

  } catch (e) {
    Logger.log("searchInDrive error: " + e.toString());
  }

  // Cache kết quả 5 phút
  try {
    if (results.length > 0) {
      CacheService.getScriptCache().put(cacheKey, JSON.stringify(results), 300);
    }
  } catch (cErr) { }

  return results;
}

function getFilesFromFolderDeep(folderObj, results, addedIds, currentDepth, maxDepth) {
  if (!folderObj || currentDepth > maxDepth || results.length >= 35) return;

  var folderNameLower = folderObj.getName().toLowerCase();
  var isOldFolder = /old|cũ|draft|nháp|archive|lưu trữ|backup/i.test(folderNameLower);

  try {
    var files = folderObj.getFiles();
    while (files && files.hasNext() && results.length < 35) {
      try {
        var file = files.next();
        if (!file) continue;
        var fileId = file.getId();
        if (!addedIds[fileId]) {
          addedIds[fileId] = true;
          results.push({
            name: file.getName(),
            url: file.getUrl(),
            mimeType: getMimeTypeLabel(file.getMimeType()),
            id: fileId,
            isFolder: false,
            parentFolderName: folderObj.getName(),
            lastUpdated: file.getLastUpdated(),
            isOld: isOldFolder
          });
        }
      } catch (fe) { }
    }
  } catch (eFiles) { }

  try {
    var innerFolders = folderObj.getFolders();
    while (innerFolders && innerFolders.hasNext() && results.length < 35) {
      try {
        var innerF = innerFolders.next();
        if (!innerF) continue;
        var innerId = innerF.getId();
        var innerNameLower = innerF.getName().toLowerCase();
        var isInnerOld = isOldFolder || /old|cũ|draft|nháp|archive|lưu trữ|backup/i.test(innerNameLower);

        if (!addedIds[innerId] && !isInnerOld) {
          addedIds[innerId] = true;
          results.push({
            name: innerF.getName(),
            url: innerF.getUrl(),
            mimeType: "📁 Thư mục (" + innerF.getName() + ")",
            id: innerId,
            isFolder: true,
            parentFolderName: folderObj.getName(),
            lastUpdated: innerF.getLastUpdated ? innerF.getLastUpdated() : null,
            isOld: false
          });
        }
        getFilesFromFolderDeep(innerF, results, addedIds, currentDepth + 1, maxDepth);
      } catch (se) { }
    }
  } catch (eSubs) { }
}

function checkTokensMatch(text, tokens) {
  for (var i = 0; i < tokens.length; i++) {
    if (text.indexOf(tokens[i]) !== -1) return true;
  }
  return false;
}

function formatDateShort(dateObj) {
  if (!dateObj || !(dateObj instanceof Date)) return "";
  var d = String(dateObj.getDate()).padStart(2, '0');
  var m = String(dateObj.getMonth() + 1).padStart(2, '0');
  var y = dateObj.getFullYear();
  return d + "/" + m + "/" + y;
}

function getMimeTypeLabel(mimeType) {
  var map = {
    "application/vnd.google-apps.spreadsheet": "📊 Google Sheet",
    "application/vnd.google-apps.document": "📄 Google Doc",
    "application/vnd.google-apps.presentation": "📑 Google Slides",
    "application/vnd.google-apps.folder": "📁 Thư mục",
    "application/pdf": "📋 PDF",
    "image/jpeg": "🖼️ Ảnh JPEG",
    "image/png": "🖼️ Ảnh PNG",
    "video/mp4": "🎬 Video",
    "application/zip": "🗜️ ZIP"
  };
  return map[mimeType] || "📄 Tài liệu";
}

function buildGuideCard(senderName) {
  var subFolders = getSubFolders();
  var widgets = [
    {
      textParagraph: {
        text: "Xin chào <b>" + senderName + "</b>! Dưới đây là danh sách các thư mục tài liệu (200. Administration ADC). Bạn có thể bấm để mở trực tiếp hoặc nhập câu hỏi (ví dụ: <i>\"ERC của AGB\"</i>, <i>\"điều lệ VPA\"</i>, <i>\"sổ đỏ\"</i>, <i>\"230\"</i>) để tôi lấy link ra cho bạn:"
      }
    }
  ];

  for (var i = 0; i < subFolders.length; i++) {
    var sf = subFolders[i];
    widgets.push({
      buttonList: {
        buttons: [{
          text: "📁 " + sf.name,
          onClick: { openLink: { url: sf.url } }
        }]
      }
    });
  }

  return {
    cardsV2: [{
      cardId: "linkAgentGuideCard",
      card: {
        header: {
          title: "📂 Danh mục Thư mục (200. Administration ADC)",
          subtitle: "Cho " + senderName,
          imageType: "CIRCLE"
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

function buildResultCard(senderName, searchQuery, results, rawText) {
  var widgets = [];

  // Tách riêng File và Folder
  var fileItems = [];
  var folderItems = [];

  for (var i = 0; i < results.length; i++) {
    if (results[i].isFolder) {
      folderItems.push(results[i]);
    } else {
      fileItems.push(results[i]);
    }
  }

  // SẮP XẾP DANH SÁCH FILE THEO ĐIỂM TƯƠNG THÍCH VÀ PHIÊN BẢN MỚI NHẤT
  fileItems.sort(function (a, b) {
    var scoreA = a.relevanceScore || 0;
    var scoreB = b.relevanceScore || 0;
    if (scoreA !== scoreB) {
      return scoreB - scoreA; // Ưu tiên file có điểm tương thích & phiên bản mới hơn!
    }
    var timeA = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
    var timeB = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
    return timeB - timeA;
  });

  // NẾU HỎI LOẠI TÀI LIỆU CỤ THỂ (ERC, IRC, ĐIỀU LỆ...): CHỈ LẤY DUY NHẤT 1 FILE MỚI NHẤT & KHỚP NHẤT!
  var fullTextCheck = (searchQuery + " " + (rawText || "")).toLowerCase();
  var isSpecificDocType = /erc|irc|điều lệ|quy định|quy chế|sổ đỏ|gpxd|pccc|bổ nhiệm|quyết định|hộ chiếu|passport|visa|work permit|bàn giao|năng lực|211\./i.test(fullTextCheck);
  var topFiles = isSpecificDocType ? fileItems.slice(0, 1) : fileItems.slice(0, 3);

  widgets.push({
    textParagraph: {
      text: "✅ Tìm thấy kết quả cho \"<b>" + searchQuery + "</b>\":"
    }
  });

  // ⭐ KHU VỰC BẢN MỚI NHẤT KHỚP VỚI CÂU HỎI
  if (topFiles.length > 0) {
    widgets.push({
      textParagraph: {
        text: isSpecificDocType ? "🔥 <b>BẢN MỚI NHẤT (CẬP NHẬT GẦN ĐÂY):</b>" : "🔥 <b>TÀI LIỆU KHỚP VỚI CÂU HỎI NHẤT:</b>"
      }
    });

    for (var f = 0; f < topFiles.length; f++) {
      var topFile = topFiles[f];
      var dateStr = formatDateShort(topFile.lastUpdated);
      var updateLabel = dateStr ? (" <i>(Cập nhật: " + dateStr + ")</i>") : "";
      var pFolder = topFile.parentFolderName ? (" <i>[" + topFile.parentFolderName + "]</i>") : "";

      widgets.push({
        textParagraph: {
          text: "⭐ <b>" + topFile.mimeType + " " + topFile.name + "</b>" + updateLabel + pFolder
        }
      });
      widgets.push({
        buttonList: {
          buttons: [{
            text: "🔗 Mở File mới nhất",
            onClick: { openLink: { url: topFile.url } },
            color: { red: 0.13, green: 0.69, blue: 0.31, alpha: 1 }
          }]
        }
      });
    }
  }

  // KHU VỰC THƯ MỤC LIÊN QUAN (NẾU CÓ) - KHÔNG HIỂN THỊ FILE CŨ
  if (folderItems.length > 0) {
    widgets.push({ divider: {} });
    widgets.push({
      textParagraph: {
        text: "📁 <b>THƯ MỤC LIÊN QUAN:</b>"
      }
    });

    var maxFoldersShow = Math.min(folderItems.length, 5);
    for (var fd = 0; fd < maxFoldersShow; fd++) {
      var folder = folderItems[fd];
      widgets.push({
        textParagraph: {
          text: "<b>" + folder.mimeType + " " + folder.name + "</b>"
        }
      });
      widgets.push({
        buttonList: {
          buttons: [{
            text: "📁 Mở Thư mục con",
            onClick: { openLink: { url: folder.url } },
            color: { red: 0.13, green: 0.59, blue: 0.95, alpha: 1 }
          }]
        }
      });
    }
  }

  return {
    cardsV2: [{
      cardId: "linkAgentResultCard",
      card: {
        header: {
          title: "🔍 Kết quả tài liệu",
          subtitle: "Cho " + senderName,
          imageType: "CIRCLE"
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

function buildNotFoundCard(senderName, searchQuery) {
  var widgets = [
    {
      textParagraph: {
        text: "Hiện tại tôi không tìm thấy dữ liệu nào liên quan tới điều bạn hỏi."
      }
    }
  ];

  return {
    cardsV2: [{
      cardId: "linkAgentNotFoundCard",
      card: {
        header: {
          title: "🔍 Không tìm thấy",
          subtitle: "Xin lỗi, " + senderName + "!",
          imageType: "CIRCLE"
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

function handleDriveSearch(query) {
  if (!query) return buildGuideCard("bạn");
  var results = searchInDrive(query);
  if (results.length > 0) return buildResultCard("bạn", query, results);
  return buildNotFoundCard("bạn", query);
}

// ============================================================================
// ✈️ 291. FLIGHT TICKET LOGIC (Tra cứu Vé máy bay & Lịch bay theo từng năm từ Google Drive)
// ============================================================================

var FLIGHT_SPREADSHEET_ID = "1dt8gAAzrzEgaDPtI41JRcH90r0GOiBHt8mLfLhuOrAM"; // Google Sheet Vé Máy Bay Sếp chính thức
var FLIGHT_SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/" + FLIGHT_SPREADSHEET_ID + "/edit#gid=1224052084"; // Link dẫn trực tiếp vào tab Ticket list
var FLIGHT_FOLDER_ID = "1E_ZRg9tRR6OPrmwrbbIaVWZzK8ASkmdK";
var FLIGHT_FOLDER_ID_2026 = "11gBHbEvyhwacLDp9U_yvagokZpvAFA_B";
var FLIGHT_FOLDER_URL_2026 = "https://drive.google.com/drive/folders/11gBHbEvyhwacLDp9U_yvagokZpvAFA_B";

/**
 * Trả về URL dẫn thẳng vào tab Ticket list trong Google Sheet
 */
function getFlightTicketSheetUrl() {
  try {
    var cached = CacheService.getScriptCache().get("FLIGHT_TICKET_TAB_URL");
    if (cached) return cached;

    var ss = SpreadsheetApp.openById(FLIGHT_SPREADSHEET_ID);
    var sheet = ss.getSheetByName("Ticket list") || ss.getSheetByName("Ticket List") || ss.getSheetByName("ticket list");
    if (sheet) {
      var tabUrl = "https://docs.google.com/spreadsheets/d/" + FLIGHT_SPREADSHEET_ID + "/edit#gid=" + sheet.getSheetId();
      try { CacheService.getScriptCache().put("FLIGHT_TICKET_TAB_URL", tabUrl, 3600); } catch (e) { }
      return tabUrl;
    }
  } catch (e) { }
  return FLIGHT_SPREADSHEET_URL;
}

var FLIGHT_TRIGGER_KEYWORDS = [
  "vé máy bay", "lịch bay", "ngày bay", "chuyến bay", "mã chuyến bay",
  "mã hành khách", "điểm đi", "điểm đến", "vé bay", "thời gian bay",
  "hạ cánh", "bay ngày", "bay từ", "bay đến", "flight ticket", "flight", "291",
  "vé sếp", "lịch sếp", "sếp bay", "vé máy bay của sếp", "lịch bay của sếp",
  "sếp đi", "sếp về", "sếp công tác", "lịch công tác của sếp",
  "vợ sếp", "lịch bay của vợ", "vé của vợ",
  "madam", "vé của madam", "lịch bay của madam",
  "có lịch bay nào", "có chuyến bay nào", "có vé bay nào",
  "lịch bay nào", "chuyến bay nào", "bay nào không"
];

function isFlightTicketRequest(text) {
  if (!text) return false;
  var lower = text.toLowerCase().trim();

  // 1. Kiểm tra từ khóa cơ bản
  for (var i = 0; i < FLIGHT_TRIGGER_KEYWORDS.length; i++) {
    if (lower.indexOf(FLIGHT_TRIGGER_KEYWORDS[i]) !== -1) return true;
  }

  // 2. Tên sếp / hành khách (Mr. Son, Son Min Chang, Madam, Vợ sếp...) + hành động bay / đi / công tác / về / sang
  if (/(?:mr\.?\s*son|son\s*min\s*chang|mr\.?\s*sơn|sơn|sếp|madam|vợ\s*sếp|boss)\s*.*(?:bay|vé|lịch|công\s*tác|đi|về|sang|tới|đến)/i.test(lower)) return true;
  if (/(?:bay|vé|lịch|công\s*tác|đi|về|sang|tới|đến)\s*.*(?:mr\.?\s*son|son\s*min\s*chang|mr\.?\s*sơn|sơn|sếp|madam|vợ\s*sếp|boss)/i.test(lower)) return true;

  // 3. Regex linh hoạt các từ khóa chuyến bay, lịch bay, ngày bay, bay về, bay đi, sang Hàn Quốc, từ Hàn Quốc...
  if (/(?:vé|lịch|chuyến|ngày|thời\s*gian|giờ)\s*(?:máy\s*bay|bay)/i.test(lower)) return true;
  if (/(?:bay|chuyến\s*bay)\s*(?:về|đi|sang|tới|đến|từ)\s*(?:hàn\s*quốc|seoul|korea|incheon|việt\s*nam|vn|hà\s*nội|hanoi|tphcm|sài\s*gòn|đà\s*nẵng|nhật|japan|tokyo)/i.test(lower)) return true;
  if (/(?:bay\s*về|bay\s*sang|bay\s*đi|bay\s*từ|bay\s*đến|có\s*bay)/i.test(lower)) return true;

  return false;
}

function handleFlightTicketRequest(text, senderName, userEmail) {
  // ── Kiểm tra quyền: chỉ team 200 (Division = "200" hoặc "000" hoặc "300") và Sếp mới được xem vé của Sếp ──
  // ── Whitelist email luôn được truy cập, không cần phân quyền Division ──
  var FLIGHT_WHITELIST_EMAILS = [
    "boss@add-group.net", "800@add-group.net", "ntttrang@planadd.com",
    "tmtam@add-group.net", "tvluat@add-group.net", "anhdd@add-group.net", "tientt@add-group.net"
  ];
  var isWhitelisted = false;
  var userEmailLower = (userEmail || "").toLowerCase().trim();
  for (var w = 0; w < FLIGHT_WHITELIST_EMAILS.length; w++) {
    if (userEmailLower === FLIGHT_WHITELIST_EMAILS[w]) { isWhitelisted = true; break; }
  }

  var userDivision = getUserDivision(userEmail);
  var allowed200 = ["200", "000", "300"];
  var hasPerm = isWhitelisted;
  if (!hasPerm) {
    for (var d = 0; d < allowed200.length; d++) {
      if (userDivision === allowed200[d]) {
        hasPerm = true;
        break;
      }
    }
  }

  if (!hasPerm) {
    return {
      cardsV2: [{
        cardId: "flightPermDeniedCard",
        card: {
          header: {
            title: "✈️ Lịch Bay & Vé Máy Bay Của Sếp",
            subtitle: "Quyền truy cập bị từ chối",
            imageType: "CIRCLE"
          },
          sections: [{
            widgets: [
              {
                textParagraph: {
                  text: "⚠️ <b>" + senderName + "</b>, bạn không có quyền tra cứu lịch bay & vé máy bay của Sếp.\n\nChức năng này <b>chỉ dành riêng cho team 200 & Ban Lãnh Đạo</b>.\nNếu bạn cho rằng đây là nhầm lẫn, vui lòng liên hệ quản trị viên."
                }
              }
            ]
          }]
        }
      }]
    };
  }

  var searchResult = searchFlightTickets(text);

  // Nếu đây là câu hỏi dạng tự nhiên (hỏi ngày nào, mấy giờ, khi nào, có bay không, bay về...):
  var isNaturalQuestion = /(?:ngày nào|lúc mấy giờ|mấy giờ|khi nào|bao giờ|bay không|đi không|đi hàn|đi korea|đi công tác|về nước|chuyến nào|mã gì|có bay|có đi|có chuyến|có về|ngày bao nhiêu|bay về|bay sang|bay đi|bay từ|về hàn|sang hàn|tới hàn|đến hàn|về việt|sang việt|không\?)/i.test(text);

  if (isNaturalQuestion) {
    var aiAnswer = answerFlightQuestionWithAI(text, senderName, searchResult);
    if (aiAnswer) {
      var widgets = [
        {
          textParagraph: {
            text: aiAnswer
          }
        },
        {
          buttonList: {
            buttons: [{
              text: "📊 Xem chi tiết trên Sheet",
              onClick: { openLink: { url: getFlightTicketSheetUrl() } },
              color: { red: 0.1, green: 0.5, blue: 0.9, alpha: 1 }
            }]
          }
        }
      ];

      return {
        cardsV2: [{
          cardId: "flightAIAnswerCard",
          card: {
            header: {
              title: "✈️ Lịch Trình Chuyến Bay ",
              subtitle: "Cho " + senderName,
              imageType: "CIRCLE"
            },
            sections: [{ widgets: widgets }]
          }
        }]
      };
    }
  }

  return buildFlightTicketCard(senderName, text, searchResult);
}

function answerFlightQuestionWithAI(userQuery, senderName, searchResult) {
  try {
    var targetYears = (searchResult && searchResult.targetYears && searchResult.targetYears.length > 0) ? searchResult.targetYears : ["2026"];
    var targetY = targetYears.join(", ");
    var rawFlights = getFlightTicketData(targetYears);

    // Lọc dữ liệu nghiêm ngặt: Chỉ lấy chuyến bay có năm trùng với targetYears (Loại bỏ triệt để file/dữ liệu năm 2025 khi tra cứu 2026)
    var allFlights = [];
    for (var i = 0; i < rawFlights.length; i++) {
      var fl = rawFlights[i];
      var dateStr = String(fl.ngayBay || "").trim();
      var yearMatch = dateStr.match(/\b(20[2-3][0-9])\b/);
      if (yearMatch && targetYears.indexOf("ALL") === -1) {
        if (targetYears.indexOf(yearMatch[0]) === -1 && targetYears.indexOf(parseInt(yearMatch[0], 10)) === -1) {
          continue; // Loại bỏ chuyến bay khác năm (VD: 2025)
        }
      }
      allFlights.push(fl);
    }

    var prompt =
      "Bạn là trợ lý AI cao cấp 200 AI chuyên phân tích tư duy & trả lời chính xác câu hỏi về Lịch trình chuyến bay của Sếp (Mr. Son, Madam...).\n" +
      "Người dùng (" + senderName + ") đang đặt câu hỏi: \"" + userQuery + "\".\n\n" +
      "DƯỚI ĐÂY LÀ TOÀN BỘ DỮ LIỆU LỊCH CHUYẾN BAY TRONG FILE GOOGLE SHEET (NĂM " + targetY + "):\n" +
      JSON.stringify(allFlights, null, 2) + "\n\n" +
      "QUY TẮC PHÂN TÍCH TƯ DUY & LẬP LUẬN (STRICT AI REASONING RULES):\n" +
      "1. QUY ĐỔI MÃ SÂN BAY TỰ ĐỘNG:\n" +
      "   - INC, ICN, SEL, PUS, BUSAN = Hàn Quốc (Incheon / Seoul / Busan).\n" +
      "   - HAN = Hà Nội (Nội Bài); SGN = TP. Hồ Chí Minh (Tân Sơn Nhất); DAD = Đà Nẵng.\n" +
      "2. BẮT BUỘC NÊU RÕ NĂM CỤ THỂ:\n" +
      "   - Khi nhắc đến tháng hay ngày, BẮT BUỘC phải ghi kèm NĂM CỤ THỂ (ví dụ: 'tháng 7/" + targetY + "' hoặc 'ngày 26/07/" + targetY + "'). KHÔNG ĐƯỢC chỉ ghi 'Tháng 7' chung chung.\n" +
      "3. PHÂN TÍCH VÀ TRẢ LỜI THÔNG MINH (STRICT MONTH & ROUTE LOGIC):\n" +
      "   - KIỂM TRA CHÍNH XÁC THÁNG & HÀNH TRÌNH ĐƯỢC HỎI:\n" +
      "     * Khi người dùng hỏi về một tháng cụ thể (VD: 'Tháng 5/2026') và địa điểm cụ thể (VD: 'đi Hàn Quốc'):\n" +
      "       + BẮT BUỘC kiểm tra xem TRONG ĐÚNG THÁNG ĐÓ (Ví dụ: Tháng 5) có chuyến bay nào có điểm đi/đến là Hàn Quốc (INC/ICN/SEL/PUS) hay không.\n" +
      "       + TUYỆT ĐỐI KHÔNG ĐƯỢC KẾT LUẬN 'Vào tháng 5/2026 Mr. Son CÓ đi Hàn Quốc' khi các chuyến bay đi Hàn Quốc diễn ra vào THÁNG 6 (01/06/2026)!\n" +
      "       + Nếu trong tháng 5/2026 chỉ có các chuyến bay nội địa (Hà Nội <-> TP.HCM) và KHÔNG CÓ chuyến bay đi Hàn Quốc, BẮT BUỘC KẾT LUẬN RÕ:\n" +
      "         'Vào <b>tháng 5/2026</b>, Mr. Son <b>KHÔNG CÓ</b> chuyến bay nào đi <b>Hàn Quốc</b> (Incheon). Trong tháng 5/2026, Mr. Son chỉ có các chuyến bay nội địa (như Hà Nội ↔ TP. Hồ Chí Minh)...'\n" +
      "       + Sau đó mới bổ sung gợi ý lịch bay Hàn Quốc gần nhất tiếp theo: 'Chuyến bay đi Hàn Quốc gần nhất của Mr. Son là vào đầu <b>tháng 6/2026</b> (ngày <b>01/06/2026</b> chặng HAN ➔ INC mã VJ962, và ngày <b>15/06/2026</b> chặng INC ➔ HAN mã VJ961)...'\n" +
      "   - NẾU TÌM THẤY CHUYẾN BAY ĐÚNG NGÀY/THÁNG & ĐÚNG HÀNH TRÌNH NGƯỜI DÙNG HỎI:\n" +
      "     * Khẳng định rõ: 'Vào [Tháng/Năm], Mr. Son CÓ chuyến bay đi [Điểm đến]...'\n" +
      "     * Trích xuất chính xác: Ngày bay, Giờ bay, Ngày hạ cánh, Giờ hạ cánh, Tên chuyến bay / Hành trình, Mã chuyến bay, Mã đặt vé (nếu có).\n" +
      "   - NẾU KHÔNG CÓ CHUYẾN BAY VÀO NGÀY/THÁNG CỤ THỂ ĐÓ:\n" +
      "     * Nêu rõ sự thật là không có chuyến bay đó vào ngày/tháng đó, sau đó liệt kê gợi ý các chuyến bay khác trong tháng/năm.\n" +
      "4. IN ĐẬM BẮT BUỘC CHO THÔNG TIN QUAN TRỌNG:\n" +
      "   - Dùng thẻ <b>...</b> để IN ĐẬM tất cả Ngày/Tháng/Năm, Tên sếp (<b>Mr. Son</b>), Địa điểm (<b>Hàn Quốc</b>, <b>Hà Nội</b>), Giờ cất cánh/hạ cánh, Mã chuyến bay...\n" +
      "5. TUYỆT ĐỐI BỎ HOÀN TOÀN LINK DRIVER & URL:\n" +
      "   - TUYỆT ĐỐI KHÔNG xuất bất kỳ đường dẫn URL link Drive (https://drive.google.com/...) hoặc các cụm '[Link xem chi tiết]' trong văn bản (hệ thống sẽ tự chèn nút bấm ở dưới).\n" +
      "6. QUY TẮC CỰC KỲ NGHIÊM NGẶT - CẤM TỰ SỬA NĂM VÀ TỰ Ý GÁN HÀNH KHÁCH (STRICT DATA INTEGRITY):\n" +
      "   - TUYỆT ĐỐI KHÔNG tự ý đổi năm 2025 thành 2026! Nếu dữ liệu ghi năm 2025 thì đó là chuyến bay năm 2025, KHÔNG ĐƯỢC biến nó thành năm 2026!\n" +
      "   - TUYỆT ĐỐI KHÔNG tự ý gán chuyến bay của hành khách khác (như Cường, Ngọc...) cho Mr. Son! Kiểm tra chính xác mã/tên hành khách!\n" +
      "   - CHỈ trích xuất đúng thông tin thực tế từ dữ liệu được cung cấp, tuyệt đối không tự sửa đổi dữ liệu!\n" +
      "7. QUY TẮC CẤM BỊA ĐẶT THÔNG TIN: Nếu bạn không biết câu trả lời hoặc trong dữ liệu không có thông tin chuyến bay được hỏi, chỉ cần nói rằng bạn không biết, đừng cố bịa ra câu trả lời cho tôi.";

    var responseText = sendtoGemini(prompt);
    if (!responseText) return null;

    // Loại bỏ toàn bộ URL Drive & Markdown link thừa
    responseText = responseText.replace(/\[(?:Link|Xem|Link xem chi tiết|Xem chi tiết)[^\]]*\]\([^)]*\)/gi, "");
    responseText = responseText.replace(/https?:\/\/[^\s\)]+/gi, "");

    // Chuyển đổi Markdown bold (**text**) sang HTML bold (<b>text</b>) để Google Chat hiển thị in đậm đậm nét
    responseText = responseText.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

    return responseText;
  } catch (e) {
    Logger.log("answerFlightQuestionWithAI error: " + e.toString());
  }
  return null;
}

// Tra cứu Division (cột K, index 10) của user từ StaffInformation sheet theo email (cột L, index 11)
function getUserDivision(email) {
  if (!email) return "";
  try {
    var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StaffInformation');
    if (!sheet) return "";

    var data = sheet.getDataRange().getValues();
    var emailLower = email.toLowerCase().trim();
    for (var r = 1; r < data.length; r++) {
      var rowEmail = String(data[r][11] || "").toLowerCase().trim(); // Cột L (index 11) = Email
      if (rowEmail === emailLower) {
        var division = String(data[r][10] || "").trim(); // Cột K (index 10) = Division
        return division;
      }
    }
  } catch (e) {
    Logger.log("getUserDivision error: " + e.toString());
  }
  return "";
}

/**
 * Tự động tìm kiếm & quét ánh xạ { [Year]: { id, url, monthlyFolders } } trong Folder 2026 (11gBHbEvyhwacLDp9U_yvagokZpvAFA_B)
 * và Folder tổng 291 (1E_ZRg9tRR6OPrmwrbbIaVWZzK8ASkmdK).
 * Sử dụng CacheService để tối ưu tốc độ (<10ms).
 */
function getFlightSheetsMap() {
  var cacheKey = "FLIGHT_SHEETS_MAP_V7";
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (ce) { }

  var fFolderUrl = (typeof FLIGHT_FOLDER_URL_2026 !== "undefined" && FLIGHT_FOLDER_URL_2026) ? FLIGHT_FOLDER_URL_2026 : "https://docs.google.com/spreadsheets/d/" + FLIGHT_SPREADSHEET_ID + "/edit";

  var map = {
    "2026": { id: FLIGHT_SPREADSHEET_ID, url: "https://docs.google.com/spreadsheets/d/" + FLIGHT_SPREADSHEET_ID + "/edit", folderUrl: fFolderUrl, monthlyFolders: {} }
  };

  // 1. Quét trực tiếp Thư mục năm 2026 theo ID chính xác do người dùng chỉ định: 11gBHbEvyhwacLDp9U_yvagokZpvAFA_B
  try {
    var folder2026 = DriveApp.getFolderById(FLIGHT_FOLDER_ID_2026);
    map["2026"].folderUrl = folder2026.getUrl();

    var sheets2026 = folder2026.getFilesByType(MimeType.GOOGLE_SHEETS);
    if (sheets2026 && sheets2026.hasNext()) {
      var sheetFile = sheets2026.next();
      map["2026"].id = sheetFile.getId();
      map["2026"].url = sheetFile.getUrl();
      map["2026"].name = sheetFile.getName();
    }

    var monthSubFolders = folder2026.getFolders();
    while (monthSubFolders && monthSubFolders.hasNext()) {
      var mFolder = monthSubFolders.next();
      var mName = mFolder.getName().trim();
      var mMatch = mName.match(/(?:tháng|thang|t)\s*(\d{1,2})/i);
      if (mMatch) {
        var monthNum = parseInt(mMatch[1], 10);
        var mFiles = [];
        try {
          var filesInMonth = mFolder.getFiles();
          while (filesInMonth && filesInMonth.hasNext()) {
            var mFile = filesInMonth.next();
            mFiles.push({
              name: mFile.getName(),
              url: mFile.getUrl(),
              id: mFile.getId()
            });
          }
        } catch (errMFiles) { }
        map["2026"].monthlyFolders[String(monthNum)] = {
          name: mName,
          url: mFolder.getUrl(),
          files: mFiles
        };
      }
    }
  } catch (err2026) {
    Logger.log("Error scanning 2026 folder " + FLIGHT_FOLDER_ID_2026 + ": " + err2026.message);
  }

  try {
    var parentFolder = DriveApp.getFolderById(FLIGHT_FOLDER_ID);

    // 1. Quét các file Sheet trực tiếp ở thư mục gốc 291
    var rootFiles = parentFolder.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (rootFiles && rootFiles.hasNext()) {
      var file = rootFiles.next();
      var fileName = file.getName();
      var fId = file.getId();
      var fUrl = file.getUrl();
      map["manual"] = { id: fId, url: fUrl, name: fileName, monthlyFolders: {} };
      var yMatch = fileName.match(/20[2-3][0-9]/);
      if (yMatch) {
        if (!map[yMatch[0]]) map[yMatch[0]] = { monthlyFolders: {} };
        map[yMatch[0]].id = fId;
        map[yMatch[0]].url = fUrl;
        map[yMatch[0]].name = fileName;
      }
    }

    // 2. Quét các Thư mục con năm (2023, 2024, 2025, 2026, Old...)
    var subFolders = parentFolder.getFolders();
    while (subFolders && subFolders.hasNext()) {
      var folder = subFolders.next();
      var folderName = folder.getName().trim();
      var folderYearMatch = folderName.match(/20[2-3][0-9]/);

      if (folderYearMatch) {
        var yearKey = folderYearMatch[0];
        if (yearKey === "2026") continue; // Đã quét trực tiếp thư mục 2026 chính chủ FLIGHT_FOLDER_ID_2026
        if (!map[yearKey]) map[yearKey] = { monthlyFolders: {} };

        // Lấy File Sheet chính của năm
        var sheets = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
        if (sheets && sheets.hasNext()) {
          var sheetFile = sheets.next();
          map[yearKey].id = sheetFile.getId();
          map[yearKey].url = sheetFile.getUrl();
          map[yearKey].name = sheetFile.getName();
        }
        map[yearKey].folderUrl = folder.getUrl();

        // 3. Quét thư mục con vé di chuyển từng tháng (VD: "Vé di chuyển tháng 6 - 2026", "Tháng 6")
        try {
          var monthSubFolders = folder.getFolders();
          while (monthSubFolders && monthSubFolders.hasNext()) {
            var mFolder = monthSubFolders.next();
            var mName = mFolder.getName().trim();
            var mMatch = mName.match(/(?:tháng|thang|t)\s*(\d{1,2})/i);
            if (mMatch) {
              var monthNum = parseInt(mMatch[1], 10);
              var mFiles = [];
              try {
                var filesInMonth = mFolder.getFiles();
                while (filesInMonth && filesInMonth.hasNext()) {
                  var mFile = filesInMonth.next();
                  mFiles.push({
                    name: mFile.getName(),
                    url: mFile.getUrl(),
                    id: mFile.getId()
                  });
                }
              } catch (errMFiles) { }
              map[yearKey].monthlyFolders[String(monthNum)] = {
                name: mName,
                url: mFolder.getUrl(),
                files: mFiles
              };
            }
          }
        } catch (errMFolders) { }
      }
    }

    try {
      CacheService.getScriptCache().put(cacheKey, JSON.stringify(map), 900); // Cache 15 phút
    } catch (e) { }

  } catch (err) {
    Logger.log("getFlightSheetsMap error: " + err.toString());
  }

  return map;
}

/**
 * Trích xuất danh sách năm từ câu hỏi của người dùng (Ví dụ: "năm 2024", "2025", "năm ngoái")
 */
function extractTargetYears(text) {
  var years = [];
  if (!text) return years;
  var lower = text.toLowerCase();
  var now = new Date();
  var currentYear = now.getFullYear();

  // "năm nay", "năm hiện tại"
  if (/năm\s*(?:nay|hiện\s*tại)/i.test(lower)) {
    years.push(currentYear);
  }
  // "năm ngoái", "năm trước"
  if (/năm\s*(?:ngoái|trước)/i.test(lower)) {
    years.push(currentYear - 1);
  }
  // "năm kia"
  if (/năm\s*kia/i.test(lower)) {
    years.push(currentYear - 2);
  }
  // "năm sau", "năm tới"
  if (/năm\s*(?:sau|tới)/i.test(lower)) {
    years.push(currentYear + 1);
  }
  // "các năm", "tất cả các năm", "tất cả năm", "lịch sử"
  if (/(?:tất\s*cả|các|lịch\s*sử)\s*năm/i.test(lower)) {
    years.push("ALL");
  }

  // Tìm các năm cụ thể 4 chữ số (ví dụ: 2023, 2024, 2025, 2026)
  var regex = /\b(20[2-3][0-9])\b/g;
  var match;
  while ((match = regex.exec(lower)) !== null) {
    var y = parseInt(match[1], 10);
    if (years.indexOf(y) === -1) {
      years.push(y);
    }
  }

  return years;
}

/**
 * Đọc dữ liệu chuyến bay theo danh sách các Năm được yêu cầu.
 */
function getFlightTicketData(targetYears) {
  var flightList = [];
  try {
    var ss = SpreadsheetApp.openById(FLIGHT_SPREADSHEET_ID);
    var targetSheet = ss.getSheetByName("Ticket list") || ss.getSheetByName("Ticket List") || ss.getSheetByName("ticket list");
    var sheetsToScan = targetSheet ? [targetSheet] : ss.getSheets();
    var nowYear = String(new Date().getFullYear());

    for (var s = 0; s < sheetsToScan.length; s++) {
      var sheet = sheetsToScan[s];
      var shName = sheet.getName().trim();

      // Bỏ qua các sheet bản sao / nháp không cần thiết nếu quét toàn bộ
      if (!targetSheet && /bản sao|copy|draft|old/i.test(shName)) continue;

      var yMatch = shName.match(/\b(20[2-3][0-9])\b/);
      var yStr = yMatch ? yMatch[0] : nowYear;

      var data = sheet.getDataRange().getDisplayValues();
      if (!data || data.length <= 1) continue;

      for (var r = 1; r < data.length; r++) {
        var row = data[r];
        // Bỏ qua nếu các ô quan trọng trống
        if (!row[0] && !row[4] && !row[5]) continue;
        // Bỏ qua dòng tiêu đề nếu chứa tên cột
        if (String(row[0]).trim().toLowerCase().indexOf("ngày bay") !== -1) continue;

        var ngayBayStr = row[0] ? String(row[0]).trim() : "";
        var yearFromRowMatch = ngayBayStr.match(/\b(20[2-3][0-9])\b/);
        var flightYear = yearFromRowMatch ? yearFromRowMatch[1] : yStr;

        // Lọc theo targetYears nếu có chỉ định
        if (targetYears && targetYears.length > 0 && targetYears.indexOf("ALL") === -1) {
          var yNum = parseInt(flightYear, 10);
          if (targetYears.indexOf(flightYear) === -1 && targetYears.indexOf(yNum) === -1) {
            continue;
          }
        }

        var tenChuyen = row[4] ? String(row[4]).trim() : "";
        var parts = tenChuyen.split("-");
        var dDi = parts[0] ? parts[0].trim() : tenChuyen;
        var dDen = parts[1] ? parts[1].trim() : tenChuyen;

        flightList.push({
          nam: flightYear,
          ngayBay: ngayBayStr,
          thoiGianBay: row[1] ? String(row[1]).trim() : "",
          ngayHaCanh: row[2] ? String(row[2]).trim() : "",
          thoiGianHaCanh: row[3] ? String(row[3]).trim() : "",
          tenChuyenBay: tenChuyen,
          diemDi: dDi,
          diemDen: dDen,
          maChuyenBay: row[5] ? String(row[5]).trim() : "",
          maDatVe: row[6] ? String(row[6]).trim() : "",
          sheetUrl: FLIGHT_SPREADSHEET_URL
        });
      }
    }
  } catch (e) {
    Logger.log("getFlightTicketData error: " + e.toString());
  }

  return flightList;
}

function extractTargetMonths(text) {
  var months = [];
  if (!text) return months;
  var lower = text.toLowerCase();

  // Lấy tháng hiện tại của hệ thống (ví dụ: tháng 8)
  var now = new Date();
  var currentMonth = now.getMonth() + 1; // 1-12

  // 1. Phân tích các cụm từ chỉ tháng tương đối: "tháng này", "tháng nay", "tháng hiện tại"
  if (/tháng\s*(?:này|nay|hiện\s*tại)/i.test(lower)) {
    months.push(currentMonth);
  }
  // "tháng sau", "tháng tới"
  if (/tháng\s*(?:tới|sau)/i.test(lower)) {
    var nextM = currentMonth + 1;
    if (nextM > 12) nextM = 1;
    months.push(nextM);
  }
  // "tháng trước"
  if (/tháng\s*trước/i.test(lower)) {
    var prevM = currentMonth - 1;
    if (prevM < 1) prevM = 12;
    months.push(prevM);
  }

  // 2. Phân tích số tháng cụ thể (ví dụ: "tháng 7", "tháng 08", "t7", "t8")
  var regex = /(?:tháng|t)\s*(\d{1,2})/gi;
  var match;
  while ((match = regex.exec(lower)) !== null) {
    var m = parseInt(match[1], 10);
    if (m >= 1 && m <= 12 && months.indexOf(m) === -1) {
      months.push(m);
    }
  }
  return months;
}

function extractMonthFromDateStr(dateStr) {
  if (!dateStr) return null;
  var parts = String(dateStr).trim().split("/");
  if (parts.length >= 2) {
    var m = parseInt(parts[1], 10);
    if (!isNaN(m)) return m;
  }
  return null;
}

function checkLocationMatch(fl, lowerQuery) {
  var diemDiLower = fl.diemDi ? fl.diemDi.toLowerCase() : "";
  var diemDenLower = fl.diemDen ? fl.diemDen.toLowerCase() : "";
  var tenChuyenLower = fl.tenChuyenBay ? fl.tenChuyenBay.toLowerCase() : "";

  // Danh sách địa điểm & bí danh mở rộng
  var aliases = [
    { key: "việt nam", keywords: ["hanoi", "hà nội", "saigon", "sài gòn", "ho chi minh", "tphcm", "danang", "đà nẵng", "vn", "vietnam", "việt nam", "han", "sgn", "dad"] },
    { key: "vietnam", keywords: ["hanoi", "hà nội", "saigon", "sài gòn", "ho chi minh", "tphcm", "danang", "đà nẵng", "vn", "vietnam", "việt nam", "han", "sgn", "dad"] },
    { key: "vn", keywords: ["hanoi", "hà nội", "saigon", "sài gòn", "ho chi minh", "tphcm", "danang", "đà nẵng", "vn", "vietnam", "việt nam", "han", "sgn", "dad"] },
    { key: "hàn quốc", keywords: ["seoul", "incheon", "busan", "hàn quốc", "korea", "sel", "icn", "inc", "pus"] },
    { key: "korea", keywords: ["seoul", "incheon", "busan", "hàn quốc", "korea", "sel", "icn", "inc", "pus"] },
    { key: "seoul", keywords: ["seoul", "sel", "incheon", "icn", "inc"] },
    { key: "hà nội", keywords: ["hanoi", "hà nội", "han"] },
    { key: "hanoi", keywords: ["hanoi", "hà nội", "han"] },
    { key: "đà nẵng", keywords: ["danang", "đà nẵng", "dad"] },
    { key: "sài gòn", keywords: ["saigon", "sài gòn", "tphcm", "ho chi minh", "sgn"] },
    { key: "tphcm", keywords: ["saigon", "sài gòn", "tphcm", "ho chi minh", "sgn"] },
    { key: "nhật", keywords: ["tokyo", "osaka", "nhật", "japan", "nrt", "kix"] },
    { key: "japan", keywords: ["tokyo", "osaka", "nhật", "japan", "nrt", "kix"] },
    { key: "tokyo", keywords: ["tokyo", "nrt"] }
  ];

  var matchedKeywords = [];
  for (var a = 0; a < aliases.length; a++) {
    if (lowerQuery.indexOf(aliases[a].key) !== -1) {
      matchedKeywords = matchedKeywords.concat(aliases[a].keywords);
    }
  }

  if (matchedKeywords.length === 0) return true; // Không hỏi địa điểm cụ thể

  // Kiểm tra hướng bay:
  var isHeadingTo = /(?:về|tới|đến|sang)\s+(?:hàn\s*quốc|korea|seoul|việt\s*nam|vietnam|vn|hà\s*nội|hanoi|đà\s*nẵng|sài\s*gòn|tphcm|nhật|japan|tokyo)/i.test(lowerQuery);
  var isHeadingFrom = /(?:từ)\s+(?:hàn\s*quốc|korea|seoul|việt\s*nam|vietnam|vn|hà\s*nội|hanoi|đà\s*nẵng|sài\s*gòn|tphcm|nhật|japan|tokyo)/i.test(lowerQuery);

  if (isHeadingTo && !isHeadingFrom) {
    for (var k = 0; k < matchedKeywords.length; k++) {
      if (diemDenLower.indexOf(matchedKeywords[k]) !== -1) return true;
    }
    return false;
  }

  if (isHeadingFrom && !isHeadingTo) {
    for (var k2 = 0; k2 < matchedKeywords.length; k2++) {
      if (diemDiLower.indexOf(matchedKeywords[k2]) !== -1) return true;
    }
    return false;
  }

  for (var k3 = 0; k3 < matchedKeywords.length; k3++) {
    var kw = matchedKeywords[k3];
    if (diemDiLower.indexOf(kw) !== -1 || diemDenLower.indexOf(kw) !== -1 || tenChuyenLower.indexOf(kw) !== -1) {
      return true;
    }
  }
  return false;
}

function extractFlightIntentByGemini(userQuery) {
  try {
    var now = new Date();
    var currentYear = now.getFullYear();
    var currentMonth = now.getMonth() + 1;

    var prompt =
      "Bạn là trợ lý AI trích xuất thông tin tìm kiếm chuyến bay.\n" +
      "Nhiệm vụ: Phân tích câu hỏi của người dùng và trả về MỘT ĐỐI TƯỢNG JSON DUY NHẤT (không dùng markdown, không viết thêm chữ nào khác).\n\n" +
      "Cấu trúc JSON cần trả về:\n" +
      "{\n" +
      "  \"targetYears\": [số năm 4 chữ số như 2023, 2024, 2025, 2026 hoặc \"ALL\"],\n" +
      "  \"targetMonths\": [số tháng 1-12],\n" +
      "  \"locationKeywords\": [\"từ khóa địa điểm như hanoi, seoul, vietnam, korea...\"],\n" +
      "  \"direction\": \"to\" | \"from\" | \"both\",\n" +
      "  \"flightCode\": \"mã chuyến bay nếu có, không có thì null\"\n" +
      "}\n\n" +
      "Quy tắc:\n" +
      "- Năm hiện tại là " + currentYear + ". 'năm ngoái' -> [" + (currentYear - 1) + "]. 'năm nay' -> [" + currentYear + "]. 'năm 2024' -> [2024]. Không nói năm -> [].\n" +
      "- Tháng hiện tại là tháng " + currentMonth + ". 'tháng này' / 'tháng nay' / 'tháng hiện tại' -> [" + currentMonth + "]. 'tháng sau' -> [" + (currentMonth === 12 ? 1 : currentMonth + 1) + "]. 'tháng 7' -> [7]. Không nói tháng -> [].\n" +
      "- 'về Việt Nam' / 'tới Việt Nam' -> direction: 'to', locationKeywords: ['hanoi', 'hà nội', 'saigon', 'sài gòn', 'tphcm', 'ho chi minh', 'danang', 'đà nẵng', 'vietnam', 'việt nam', 'vn'].\n" +
      "- 'về Hàn Quốc' / 'tới Seoul' -> direction: 'to', locationKeywords: ['seoul', 'incheon', 'busan', 'hàn quốc', 'korea'].\n" +
      "- 'từ Hàn Quốc' -> direction: 'from', locationKeywords: ['seoul', 'incheon', 'busan', 'hàn quốc', 'korea'].\n" +
      "- Không ghi hướng -> direction: 'both'. Không có địa điểm -> locationKeywords: [].\n" +
      "- Nếu không biết câu trả lời hoặc không xác định được thông tin, trả về các mảng rỗng, đừng cố bịa ra dữ liệu cho tôi.\n\n" +
      "Câu hỏi: \"" + userQuery + "\"";

    var aiResponse = sendtoGemini(prompt);
    if (!aiResponse) return null;

    var cleanJson = aiResponse.replace(/```json/gi, "").replace(/```/g, "").trim();
    var intent = JSON.parse(cleanJson);

    if (intent && (Array.isArray(intent.targetMonths) || Array.isArray(intent.targetYears))) {
      return intent;
    }
  } catch (e) {
    Logger.log("extractFlightIntentByGemini error: " + e.toString());
  }
  return null;
}

function searchFlightTickets(userQuery) {
  if (!userQuery) {
    var defaultFlights = getFlightTicketData([]);
    return { flights: defaultFlights, targetYears: [], targetMonths: [], sheetsMap: getFlightSheetsMap() };
  }

  var lower = userQuery.toLowerCase().trim();

  // 1. Thử dùng AI Gemini để hiểu ý định câu hỏi chính xác 100%
  var aiIntent = extractFlightIntentByGemini(userQuery);

  var targetYears = [];
  var targetMonths = [];
  var flightCodeTerm = null;
  var hasLocation = false;
  var locationKeywords = [];
  var direction = "both";

  if (aiIntent) {
    Logger.log("[AI Flight Intent] " + JSON.stringify(aiIntent));
    targetYears = aiIntent.targetYears || [];
    targetMonths = aiIntent.targetMonths || [];
    flightCodeTerm = aiIntent.flightCode ? String(aiIntent.flightCode).toLowerCase().replace(/\s+/g, "") : null;
    locationKeywords = aiIntent.locationKeywords || [];
    hasLocation = locationKeywords.length > 0;
    direction = aiIntent.direction || "both";
  } else {
    // 2. Fallback sang Regex nếu AI chưa có phản hồi hoặc bị lỗi
    targetYears = extractTargetYears(lower);
    targetMonths = extractTargetMonths(lower);
    var codeMatch = lower.match(/([a-z]{2}\s*\d{3,4})/i);
    if (codeMatch && codeMatch[1]) {
      flightCodeTerm = codeMatch[1].replace(/\s+/g, "").toLowerCase();
    }
    var aliases = ["việt nam", "vietnam", "vn", "hàn quốc", "korea", "seoul", "hà nội", "hanoi", "đà nẵng", "sài gòn", "tphcm", "incheon", "busan", "tokyo", "danang", "saigon", "nhật", "japan"];
    for (var al = 0; al < aliases.length; al++) {
      if (lower.indexOf(aliases[al]) !== -1) { hasLocation = true; break; }
    }
  }

  var sheetsMap = getFlightSheetsMap();
  var allFlights = getFlightTicketData(targetYears);

  // Nếu không có bộ lọc tháng, địa điểm hay mã chuyến bay -> trả về toàn bộ danh sách năm đó
  if (targetMonths.length === 0 && flightCodeTerm === null && !hasLocation) {
    return { flights: allFlights, targetYears: targetYears, targetMonths: targetMonths, sheetsMap: sheetsMap };
  }

  // 3. Lọc danh sách chuyến bay thỏa mãn ĐỒNG THỜI các điều kiện (AND filtering)
  var filtered = [];

  for (var i = 0; i < allFlights.length; i++) {
    var fl = allFlights[i];
    var flMonth = extractMonthFromDateStr(fl.ngayBay);

    // Bắt buộc thuộc một trong các Tháng được chỉ định
    if (targetMonths.length > 0) {
      if (targetMonths.indexOf(flMonth) === -1) continue;
    }

    // Bắt buộc trùng Địa điểm / Hướng bay nếu có
    if (hasLocation) {
      if (aiIntent && locationKeywords.length > 0) {
        var diemDiL = (fl.diemDi || "").toLowerCase();
        var diemDenL = (fl.diemDen || "").toLowerCase();
        var locMatch = false;

        if (direction === "to") {
          for (var k = 0; k < locationKeywords.length; k++) {
            if (diemDenL.indexOf(locationKeywords[k].toLowerCase()) !== -1) { locMatch = true; break; }
          }
        } else if (direction === "from") {
          for (var k2 = 0; k2 < locationKeywords.length; k2++) {
            if (diemDiL.indexOf(locationKeywords[k2].toLowerCase()) !== -1) { locMatch = true; break; }
          }
        } else {
          for (var k3 = 0; k3 < locationKeywords.length; k3++) {
            var kwL = locationKeywords[k3].toLowerCase();
            if (diemDiL.indexOf(kwL) !== -1 || diemDenL.indexOf(kwL) !== -1) { locMatch = true; break; }
          }
        }
        if (!locMatch) continue;
      } else {
        if (!checkLocationMatch(fl, lower)) continue;
      }
    }

    // Bắt buộc trùng Mã chuyến bay nếu có
    if (flightCodeTerm !== null) {
      var flCodeClean = fl.maChuyenBay ? fl.maChuyenBay.toLowerCase().replace(/\s+/g, "") : "";
      if (flCodeClean.indexOf(flightCodeTerm) === -1) continue;
    }

    filtered.push(fl);
  }

  return { flights: filtered, targetYears: targetYears, targetMonths: targetMonths, sheetsMap: sheetsMap };
}

function buildFlightTicketCard(senderName, searchQuery, searchResult) {
  var flightList = searchResult ? searchResult.flights : [];
  var targetYears = searchResult ? searchResult.targetYears : [];
  var targetMonths = searchResult ? searchResult.targetMonths : [];
  var widgets = [];

  var yearSubtitle = targetYears.length > 0 ? " (Năm " + targetYears.join(", ") + ")" : "";

  if (!flightList || flightList.length === 0) {
    widgets.push({
      textParagraph: {
        text: "🗓️ <b>Hiện không tìm thấy dữ liệu chuyến bay nào trong hệ thống Google Sheet.</b>"
      }
    });
  } else {
    widgets.push({
      textParagraph: {
        text: "✈️ <b>DANH SÁCH LỊCH CHUYẾN BAY (TỪ GOOGLE SHEET):</b>"
      }
    });

    var displayCount = Math.min(flightList.length, 10);
    for (var i = 0; i < displayCount; i++) {
      var fl = flightList[i];
      var maDatVeStr = fl.maDatVe ? (" <i>(Mã đặt vé: <b>" + fl.maDatVe + "</b>)</i>") : "";
      var flightInfoHtml =
        "<b>" + (i + 1) + ". Mã chuyến bay: <font color='#1a73e8'>" + (fl.maChuyenBay || "N/A") + "</font></b>" + maDatVeStr + "\n" +
        "  • <b>Tên chuyến bay:</b> <b>" + (fl.tenChuyenBay || (fl.diemDi + " - " + fl.diemDen)) + "</b>\n" +
        "  • <b>Ngày bay:</b> " + (fl.ngayBay || "N/A") + " <i>(Giờ bay: " + (fl.thoiGianBay || "-") + ")</i>\n" +
        "  • <b>Ngày & Giờ hạ cánh:</b> " + (fl.ngayHaCanh || fl.ngayBay || "N/A") + " <i>(Giờ hạ cánh: " + (fl.thoiGianHaCanh || "-") + ")</i>";

      widgets.push({
        textParagraph: { text: flightInfoHtml }
      });
    }
  }

  widgets.push({ divider: {} });
  widgets.push({
    buttonList: {
      buttons: [{
        text: "📊 Mở Sheet Vé Máy Bay Của Sếp",
        onClick: { openLink: { url: getFlightTicketSheetUrl() } },
        color: { red: 0.1, green: 0.5, blue: 0.9, alpha: 1 }
      }]
    }
  });

  return {
    cardsV2: [{
      cardId: "flightTicketCard",
      card: {
        header: {
          title: "✈️ Lịch Bay & Vé Máy Bay Của Sếp",
          subtitle: "Cho " + senderName + yearSubtitle,
          imageType: "CIRCLE"
        },
        sections: [{ widgets: widgets }]
      }
    }]
  };
}

// ============================================================
// 🌴 Tra cứu số ngày phép còn lại từ sheet Vacation Chart
// ============================================================

function normalizeNameForVacationMatch(str) {
  if (!str) return '';
  return str.toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(mr|ms|mrs|cô|thầy|anh|chị|em|bạn)\s*/gi, "")
    .replace(/[^a-z0-9]/g, "");
}

function getVacationDays(queryText, displayName, userEmail) {
  try {
    var sheetID = '1ytMbWdEFGrAgyL0xKgp9OzTAOO62Sh7ma1WSOlFK2m4';
    var sheetName = 'Vacation Chart';
    var ss = SpreadsheetApp.openById(sheetID);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return null;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    // Đọc: cột A (tên), cột B (Pháp 17), cột C (Remain)
    var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

    // 1. Trích xuất tên đối tượng được hỏi trong câu lệnh (Ví dụ: "duy anh", "MrDuyAnh", "Quỳnh Trang")
    var extractedName = '';
    if (queryText) {
      var cleaned = queryText.toLowerCase()
        .replace(/(?:cho\s*tôi|cho\s*em|cho\s*anh|cho\s*chị|cho\s*mình|cho|xin|giúp|với|ạ|dùm|có\s*bao\s*nhiêu|bao\s*nhiêu|mấy|hỏi|cho\s*hỏi|tra|xem|kiểm\s*tra|số|tổng|ngày\s*phép|ngày\s*phéo|phép\s*năm|phép\s*còn|còn\s*phép|số\s*phép|phép\s*lại|nghỉ\s*phép|phép|phéo|vacation|leave|còn|của|hiện\s*tại|lại|về)/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      var normCleaned = normalizeNameForVacationMatch(cleaned);
      if (normCleaned && normCleaned !== 'toi' && normCleaned !== 'minh' && normCleaned !== 'em' && normCleaned !== 'anh' && normCleaned !== 'chi') {
        extractedName = cleaned;
      }
    }

    var searchTargets = [];
    var targetLabel = '';

    if (extractedName) {
      // Người dùng hỏi đích danh 1 người khác (VD: "duy anh", "MrDuyAnh", "Quỳnh Trang")
      targetLabel = extractedName;
      var normExtracted = normalizeNameForVacationMatch(extractedName);
      if (normExtracted) searchTargets.push(normExtracted);
    } else {
      // Hỏi cho bản thân người chat
      targetLabel = displayName;
      try {
        var staffDetail = getStaffDetailByEmailOrName(userEmail, displayName);
        if (staffDetail && staffDetail.fullName) {
          var normStaff = normalizeNameForVacationMatch(staffDetail.fullName);
          if (normStaff) searchTargets.push(normStaff);
        }
      } catch (eStaff) { }

      var normDisplay = normalizeNameForVacationMatch(displayName);
      if (normDisplay && searchTargets.indexOf(normDisplay) === -1) {
        searchTargets.push(normDisplay);
      }
    }

    for (var i = 0; i < data.length; i++) {
      var rawName = (data[i][0] || '').toString().trim();
      var normRowName = normalizeNameForVacationMatch(rawName);
      if (!normRowName) continue;

      var matched = false;
      for (var s = 0; s < searchTargets.length; s++) {
        var target = searchTargets[s];
        if (!target) continue;
        if (normRowName === target || normRowName.includes(target) || target.includes(normRowName)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        var phap17 = data[i][1]; // Cột B - Tổng phép quy định
        var remain = data[i][2]; // Cột C - Phép còn lại

        var phap17Val = (phap17 !== '' && phap17 !== null && phap17 !== undefined) ? phap17 : '0';
        var hasRemain = (remain !== '' && remain !== null && remain !== undefined);
        var remainVal = hasRemain ? remain : phap17Val; // Nếu Remain trống thì lấy ở cột B

        return {
          found: true,
          name: rawName,
          phap17: phap17Val,
          remain: remainVal,
          isRemainFromColB: !hasRemain
        };
      }
    }

    return {
      found: false,
      targetLabel: targetLabel || displayName
    };
  } catch (e) {
    Logger.log('[VacationQuery] Lỗi đọc sheet: ' + e.message);
    return null;
  }
}

function handleVacationQuery(queryText, displayName, userEmail) {
  var result = getVacationDays(queryText, displayName, userEmail);

  if (!result) {
    return {
      text: '😔 Xin lỗi anh/chị *' + displayName + '*, hệ thống đang gặp sự cố khi tra cứu dữ liệu ngày phép. Vui lòng thử lại sau!'
    };
  }

  if (!result.found) {
    return {
      text: '🔍 Anh/chị *' + displayName + '*, hệ thống chưa tìm thấy thông tin ngày phép của *' + result.targetLabel + '* trong bảng Vacation Chart. Vui lòng kiểm tra lại tên hoặc liên hệ Phòng 200 (Hành chính Nhân sự) để được hỗ trợ nhé!'
    };
  }

  var msg = '🌴 *Thông tin ngày phép của anh/chị ' + result.name + ':*\n\n' +
    '📅 Tổng số ngày phép theo quy định: *' + result.phap17 + ' ngày*\n' +
    '✅ Số ngày phép còn lại: *' + result.remain + ' ngày*';

  if (result.isRemainFromColB) {
    msg += ' _(dữ liệu lấy từ cột B do cột Remain chưa có số liệu)_';
  }

  return { text: msg };
}

// -----------------------------------------------------------------------------
// 🧹 HỆ THỐNG TRIGGER NHẮC NHỞ & PHÂN CÔNG GIÁM SÁT VỆ SINH PHÒNG 200 (TASK 275)
// -----------------------------------------------------------------------------

var DEPT_200_MEMBERS = [
  { name: "Tô Vũ Luật", email: "tvluat@add-group.net", nick: "000.Luat" },
  { name: "Đỗ Duy Anh", email: "anhdd@add-group.net", nick: "200.Duy Anh" },
  { name: "Triệu Thủy Tiên", email: "tientt@add-group.net", nick: "200.Tien" },
  { name: "Đào Bá Đạt", email: "800@add-group.net", nick: "200.Dat" }
];

function getCleaningScheduleForWeek(weekKey, forceReset) {
  if (!weekKey) {
    var now = new Date();
    var startOfYear = new Date(now.getFullYear(), 0, 1);
    var weekNum = Math.ceil((((now - startOfYear) / 86400000) + startOfYear.getDay() + 1) / 7);
    weekKey = "CLEANING_SCHEDULE_W" + now.getFullYear() + "_" + weekNum;
  }

  try {
    var props = PropertiesService.getScriptProperties();
    if (!forceReset) {
      var cached = props.getProperty(weekKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }
  } catch (e) { }

  // 🔀 THUẬT TOÁN PHÂN CÔNG 4 NGƯỜI PHÒNG 200 TRONG 5 NGÀY (4 NGƯỜI 4 NGÀY + 1 NGÀY BỎ TRỐNG):
  // 1. Tạo mảng 5 vị trí: 4 người phòng 200 + 1 vị trí null (bỏ trống)
  var fiveDaysAssignments = DEPT_200_MEMBERS.slice();
  fiveDaysAssignments.push(null); // Ngày thứ 5 bỏ trống không phân công

  // 2. Xáo trộn ngẫu nhiên 5 vị trí trong tuần (Fisher-Yates Shuffle)
  for (var k = fiveDaysAssignments.length - 1; k > 0; k--) {
    var m = Math.floor(Math.random() * (k + 1));
    var tmp = fiveDaysAssignments[k];
    fiveDaysAssignments[k] = fiveDaysAssignments[m];
    fiveDaysAssignments[m] = tmp;
  }

  var daysOfWeekNames = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6"];
  var schedule = [];
  for (var d = 0; d < 5; d++) {
    schedule.push({
      dayIndex: d + 1, // 1: Thứ 2, ..., 5: Thứ 6
      dayName: daysOfWeekNames[d],
      person: fiveDaysAssignments[d]
    });
  }

  try {
    PropertiesService.getScriptProperties().setProperty(weekKey, JSON.stringify(schedule));
  } catch (pe) { }

  return schedule;
}

function handleCleaningScheduleQuery(senderName, isForceReset) {
  var schedule = getCleaningScheduleForWeek(null, isForceReset);
  var today = new Date();
  var dayOfWeek = today.getDay(); // 0: CN, 1: T2, ..., 5: T6, 6: T7

  var todayPersonName = "Nghỉ cuối tuần";
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    var todayAssignment = schedule[dayOfWeek - 1];
    if (todayAssignment) {
      if (todayAssignment.person) {
        todayPersonName = todayAssignment.person.name + " (" + todayAssignment.person.email + ")";
      } else {
        todayPersonName = "Bỏ trống (Không phân công)";
      }
    }
  }

  var resetNotice = isForceReset ? " 🔄 _(Đã xáo trộn ngẫu nhiên lại lịch mới!)_" : "";
  var msg = "🧹 *BẢNG PHÂN CÔNG GIÁM SÁT VỆ SINH CÔNG TY TUẦN NÀY (Task 275)*" + resetNotice + "\n" +
    "_Dành cho Phòng 200 (Hành chính Nhân sự) - Cho " + senderName + "_\n\n" +
    "📢 *NGƯỜI TRỰC BAN HÔM NAY:* *" + todayPersonName + "*\n\n" +
    "📋 *LỊCH TRỰC CHIA 4 NGƯỜI (4 NGÀY + 1 NGÀY BỎ TRỐNG):*\n";

  for (var s = 0; s < schedule.length; s++) {
    var item = schedule[s];
    var isTodayMark = (dayOfWeek === item.dayIndex) ? " 👈 *[HÔM NAY]*" : "";
    var personDisplay = item.person ? (item.person.name + " (" + item.person.nick + ")") : "_Bỏ trống_";
    msg += "• *" + item.dayName + ":* " + personDisplay + isTodayMark + "\n";
  }

  msg += "\n📌 _Yêu cầu: Người trực ban kiểm tra vệ sinh văn phòng & cập nhật tiến độ Task 275 mỗi ngày._\n" +
    "🔗 *Link Sheet cập nhật Task 275:* https://docs.google.com/spreadsheets/d/1Mb9EEfxouUS0hFxL5wM4Cur7weJW6804chDN8WetAQ0/edit?gid=1404191066#gid=1404191066";

  return { text: msg };
}

function sendDailyCleaningReminderTrigger() {
  var today = new Date();
  var dayOfWeek = today.getDay(); // 0: Sunday, 1: Mon, ..., 5: Fri, 6: Sat

  // Nếu là Thứ 7 hoặc Chủ nhật -> Không chạy nhắc nhở
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    Logger.log("Nghỉ cuối tuần, không gửi nhắc nhở vệ sinh.");
    return;
  }

  var schedule = getCleaningScheduleForWeek();
  var todayAssignment = schedule[dayOfWeek - 1];
  if (!todayAssignment || !todayAssignment.person) {
    Logger.log("Hôm nay là ngày bỏ trống, không có phân công trực vệ sinh.");
    return;
  }

  var assignedPerson = todayAssignment.person;
  var dateStr = Utilities.formatDate(today, "GMT+7", "dd/MM/yyyy");

  var messageText = "🧹 *[NHẮC NHỞ TỰ ĐỘNG HÀNG NGÀY] GIÁM SÁT VỆ SINH CÔNG TY (Task 275)*\n" +
    "_Gửi đến Nhóm chat 200. Notification_\n\n" +
    "🗓️ *Hôm nay (" + todayAssignment.dayName + " - " + dateStr + "):*\n" +
    "👤 *NGƯỜI TRỰC BAN VỆ SINH:* *" + assignedPerson.name + "* (" + assignedPerson.email + ")\n\n" +
    "📌 *Nhiệm vụ kiểm tra vệ sinh (Task 275):*\n" +
    "• Đi kiểm tra tổng thể vệ sinh công ty (sàn nhà, bàn làm việc, khu vực chung, phòng họp).\n" +
    "• Cập nhật tiến độ vào hạng mục: _275. Clean office and administrative work_.\n" +
    "🔗 *Link Sheet cập nhật Task 275:* https://docs.google.com/spreadsheets/d/1Mb9EEfxouUS0hFxL5wM4Cur7weJW6804chDN8WetAQ0/edit?gid=1404191066#gid=1404191066";

  Logger.log("Gửi nhắc nhở vệ sinh hôm nay cho: " + assignedPerson.name + "\nNội dung: " + messageText);

  // 1. Gửi trực tiếp qua Google Chat Advanced Service API tới Space ID (spaces/AAAAydfqUL0 / spaces/AAQA2_sKqYQ)
  var sentViaApi = false;
  var targetSpaceIds = ["spaces/AAAAydfqUL0", "spaces/AAQA2_sKqYQ", "spaces/AAAA2_sKqYQ"];

  for (var sp = 0; sp < targetSpaceIds.length; sp++) {
    try {
      if (typeof Chat !== "undefined" && Chat.Spaces && Chat.Spaces.Messages) {
        Chat.Spaces.Messages.create({ text: messageText }, targetSpaceIds[sp]);
        Logger.log("Đã gửi trực tiếp thông báo tới Space ID thành công: " + targetSpaceIds[sp]);
        sentViaApi = true;
        break;
      }
    } catch (eChat) {
      Logger.log("Chat API error cho " + targetSpaceIds[sp] + ": " + eChat.message);
    }
  }

  // 2. Dự phòng: Gửi qua Webhook URL nếu được cấu hình
  if (!sentViaApi) {
    var webhookUrl = PropertiesService.getScriptProperties().getProperty("CLEANING_WEBHOOK_URL") ||
      PropertiesService.getScriptProperties().getProperty("NOTIFICATION_200_WEBHOOK_URL");

    if (webhookUrl) {
      try {
        UrlFetchApp.fetch(webhookUrl, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({ text: messageText })
        });
        Logger.log("Đã gửi thành công thông báo vào nhóm chat 200. Notification qua Webhook!");
      } catch (e) {
        Logger.log("Lỗi gửi Webhook nhắc vệ sinh: " + e.message);
      }
    }
  }
}

function setCleaningWebhookUrl(webhookUrl) {
  if (!webhookUrl) return "Vui lòng truyền Webhook URL hợp lệ!";
  PropertiesService.getScriptProperties().setProperty("CLEANING_WEBHOOK_URL", webhookUrl.trim());
  return "✅ Đã lưu Webhook URL cho Nhóm chat 200. Notification thành công!";
}

function setupCleaningDailyTrigger() {
  // Xóa trigger cũ trùng tên (nếu có)
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "sendDailyCleaningReminderTrigger") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Tạo Trigger chạy hàng ngày từ 8h - 9h sáng
  ScriptApp.newTrigger("sendDailyCleaningReminderTrigger")
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  Logger.log("Đã tạo Trigger nhắc vệ sinh 8h sáng hàng ngày cho Nhóm chat 200. Notification thành công!");
}

/**
 * 🧪 HÀM CHẠY THỬ NGHIỆM TỨC THÌ (RUN TEST BEFORE SETTING UP TRIGGER)
 * Chọn hàm này trên thanh công cụ Apps Script và nhấn "Run" để kiểm tra kết quả ngay lập tức!
 */
function testSendDailyCleaningReminder() {
  // Mỗi lần nhấn Run Test, tự động xáo trộn ngẫu nhiên lại lịch mới để kiểm tra tính năng Random!
  var schedule = getCleaningScheduleForWeek(null, true);
  var today = new Date();
  var dayOfWeek = today.getDay(); // 0: Sunday, 1: Mon, ..., 5: Fri, 6: Sat

  // Nếu rơi vào cuối tuần hoặc ngày bỏ trống thì chọn ngày đầu tiên có người trực để thử nghiệm
  var todayIndex = (dayOfWeek >= 1 && dayOfWeek <= 5) ? (dayOfWeek - 1) : 0;
  if (!schedule[todayIndex] || !schedule[todayIndex].person) {
    for (var i = 0; i < schedule.length; i++) {
      if (schedule[i].person) {
        todayIndex = i;
        break;
      }
    }
  }
  var todayAssignment = (schedule && schedule[todayIndex]) ? schedule[todayIndex] : { dayName: "Thứ Hai", person: { name: "Thành viên 200", email: "200@add-group.net" } };
  var assignedPerson = (todayAssignment && todayAssignment.person) ? todayAssignment.person : { name: "Thành viên 200", email: "200@add-group.net" };
  var dateStr = Utilities.formatDate(today, "GMT+7", "dd/MM/yyyy");

  var messageText = "🧪 *[THỬ NGHIỆM TỰ ĐỘNG] GIÁM SÁT VỆ SINH CÔNG TY (Task 275)*\n" +
    "_Thông báo thử nghiệm gửi đến Nhóm 200. Notification_\n\n" +
    "🗓️ *Hôm nay (" + todayAssignment.dayName + " - " + dateStr + "):*\n" +
    "👤 *NGƯỜI TRỰC BAN VỆ SINH:* *" + assignedPerson.name + "* (" + assignedPerson.email + ")\n\n" +
    "📌 *Nhiệm vụ kiểm tra vệ sinh (Task 275):*\n" +
    "• Đi kiểm tra tổng thể vệ sinh công ty (sàn nhà, bàn làm việc, khu vực chung, phòng họp).\n" +
    "• Cập nhật tiến độ vào hạng mục: _275. Clean office and administrative work_.\n" +
    "🔗 *Link Sheet cập nhật Task 275:* https://docs.google.com/spreadsheets/d/1Mb9EEfxouUS0hFxL5wM4Cur7weJW6804chDN8WetAQ0/edit?gid=1404191066#gid=1404191066";

  Logger.log("[TEST] Nội dung tin nhắn chuẩn bị gửi:\n" + messageText);

  var sentCount = 0;
  var targetSpaceIds = ["spaces/AAAAydfqUL0", "spaces/AAQA2_sKqYQ", "spaces/AAAA2_sKqYQ"];

  for (var sp = 0; sp < targetSpaceIds.length; sp++) {
    try {
      if (typeof Chat !== "undefined" && Chat.Spaces && Chat.Spaces.Messages) {
        Chat.Spaces.Messages.create({ text: messageText }, targetSpaceIds[sp]);
        Logger.log("✅ [TEST SUCCESS] Đã gửi thành công tin nhắn thử nghiệm tới Space: " + targetSpaceIds[sp]);
        sentCount++;
        break;
      }
    } catch (eChat) {
      Logger.log("⚠️ Chat API error cho " + targetSpaceIds[sp] + ": " + eChat.message);
    }
  }

  var webhookUrl = PropertiesService.getScriptProperties().getProperty("CLEANING_WEBHOOK_URL") ||
    PropertiesService.getScriptProperties().getProperty("NOTIFICATION_200_WEBHOOK_URL");

  if (webhookUrl) {
    try {
      UrlFetchApp.fetch(webhookUrl, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ text: messageText })
      });
      Logger.log("✅ [TEST SUCCESS] Đã gửi thành công tin nhắn thử nghiệm qua Webhook!");
      sentCount++;
    } catch (eWeb) {
      Logger.log("⚠️ Webhook error: " + eWeb.message);
    }
  }

  if (sentCount > 0) {
    return "🎉 GỬI THỬ NGHIỆM THÀNH CÔNG! Đã gửi thông báo đến nhóm 200. Notification.";
  } else {
    return "⚠️ CHƯA GỬI ĐƯỢC: Vui lòng kiểm tra quyền Chat API hoặc cấu hình Webhook URL trong Script Properties!";
  }
}
