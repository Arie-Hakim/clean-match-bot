const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // חובה עבור Render

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// הגבלת עומס (Rate Limiting)
app.use('/whatsapp', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// חיבורים חיצוניים
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// הגדרות מערכת
const CONFIG = {
    TWILIO_NUMBER: 'whatsapp:+14155238886',
    CRON_SECRET: process.env.CRON_SECRET || 'AryehMasterKey',
    AUCTION_WAIT_MINUTES: 2, 
    BIDS_LIMIT: 5,           
    TEMPLATES: {
        CHOOSE_ROLE: 'HXcde09f46bc023aa95fd7bb0a705fa2dc',
        CLIENT_CITY: 'HX232d288f7201dcedae6c483b80692b9d',
        CLEANER_CITY: 'HXd9def526bc4c9013994cfe6a3b0d4898', 
        ADD_CITY: 'HX562db4f76686ae94f9827ba35d75a1cd',    
        CLIENT_MENU: 'HX3ae58035fa14b0f81c94e98093b582fa',
        SELECT_DAY: 'HX69270232323e170ed106fd8e01395ed4',
        JOB_OFFER: 'HXef6e04eba99339e6a96a071cf7aa279b'
    },
    DAYS: ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "מוצאי שבת"]
};

// סטטוסים מופרדים
const STATES = {
    REG_NAME: 'reg_name',
    CLN_CITY: 'cln_city',
    CLN_PRICE: 'cln_price',
    CLN_BIO: 'cln_bio',
    CLN_READY: 'cln_ready',
    CLI_READY: 'cli_ready',
    CLI_DAY: 'cli_day',
    CLI_TIME: 'cli_time'
};

// ==================== שירותים (Services) ====================

const Messaging = {
    async sendMsg(to, body) {
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, body }); } 
        catch (e) { console.error(`[Msg Error] ${e.message}`); }
    },
    async sendT(to, sid, vars = {}) {
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, contentSid: sid, contentVariables: JSON.stringify(vars) }); } 
        catch (e) { console.error(`[Tpl Error] ${e.message}`); }
    }
};

const Auction = {
    async closeAndNotify(jobId, clientPhone) {
        console.log(`[Auction] Closing Job ${jobId}`);
        const { data: bids } = await supabase.rpc('get_job_bids', { p_job_id: jobId });
        
        if (!bids || bids.length === 0) {
            await supabase.from('jobs').update({ status: 'cancelled' }).eq('id', jobId);
            return Messaging.sendMsg(clientPhone, "😔 לא נמצאו הצעות למכרז זה.");
        }

        let msg = `מצאנו ${bids.length} הצעות עבורך! 🎉\n\n`;
        bids.forEach((b, i) => {
            msg += `${i + 1}️⃣ *${b.full_name}*\n⭐ דירוג: ${b.rating} (${b.total_jobs} עבודות)\n💰 מחיר: ${b.bid_price}₪\n📝 "${b.bio}"\n\n`;
        });
        msg += `לבחירה, שלח/י את המספר (למשל: 1)`;
        
        await Messaging.sendMsg(clientPhone, msg);
        await supabase.from('jobs').update({ status: 'awaiting_selection' }).eq('id', jobId);
    }
};

const validateTwilio = (req, res, next) => {
    const signature = req.headers['x-twilio-signature'];
    const url = (process.env.WEBHOOK_URL || '').trim() + req.originalUrl;
    // אימות רק בפרודקשן
    if (process.env.NODE_ENV === 'production' && !twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) {
        console.error(`❌ [Security] Auth Failed: ${url}`);
        return res.status(403).send('Forbidden');
    }
    return next();
};

// ==================== לוגיקה עסקית (Handlers) ====================

const Handlers = {
    // === מנקה ===
    async cleaner(from, profile, msg) {
        const state = profile.temp_state;
        const jobId = profile.current_job_id;

        console.log(`[Cleaner Flow] State: ${state}, Msg: ${msg}`);

        // 1. הגשת הצעה
        if (state === 'bid_price' && jobId) {
            // טיפול בפסיקים והמרה למספר
            const normalizedMsg = msg.replace(',', '.').replace(/[^0-9.]/g, '');
            const price = parseFloat(normalizedMsg);

            if (isNaN(price) || price <= 0) return Messaging.sendMsg(from, "נא להזין מחיר תקין במספרים (למשל: 150).");
            
            const { data: r } = await supabase.rpc('submit_bid', { p_job_id: jobId, p_cleaner_phone: from, p_price: price });
            await supabase.from('profiles').update({ temp_state: STATES.CLN_READY, current_job_id: null }).eq('phone_number', from);
            
            if (!r[0].success) return Messaging.sendMsg(from, "המכרז נסגר.");
            
            if (r[0].bid_count === 1) await supabase.from('jobs').update({ bid_deadline: new Date(Date.now() + CONFIG.AUCTION_WAIT_MINUTES * 60000).toISOString() }).eq('id', jobId);
            if (r[0].bid_count >= CONFIG.BIDS_LIMIT) {
                const { data: j } = await supabase.from('jobs').select('client_phone').eq('id', jobId).single();
                await Auction.closeAndNotify(jobId, j.client_phone);
            }
            return Messaging.sendMsg(from, "ההצעה נשלחה בהצלחה! 🤞 נעדכן אותך.");
        }

        if (msg === 'אני פנוי/ה' && jobId) {
            await supabase.from('profiles').update({ temp_state: 'bid_price' }).eq('phone_number', from);
            return Messaging.sendMsg(from, "מעולה! מה הצעת המחיר שלך לעבודה זו?");
        }

        // 2. רישום מנקה
        switch (state) {
            case STATES.CLN_CITY:
                // לוגיקה מעגלית: כן -> רשימה, לא -> הלאה
                if (msg === 'כן' || msg === 'Yes' || msg.includes('עוד ערים')) {
                    return Messaging.sendT(from, CONFIG.TEMPLATES.CLEANER_CITY);
                }
                
                if (msg === 'לא' || msg === 'זהו' || msg === 'no_more_cities') {
                    await supabase.from('profiles').update({ temp_state: STATES.CLN_PRICE }).eq('phone_number', from);
                    return Messaging.sendMsg(from, "מצוין. מה המחיר הממוצע שלך לשעה? (למשל: 80₪)");
                } 
                
                // הוספת עיר
                const currentCities = profile.city || "";
                if (!currentCities.includes(msg)) {
                    const updated = currentCities ? `${currentCities}, ${msg}` : msg;
                    await supabase.from('profiles').update({ city: updated }).eq('phone_number', from);
                }
                return Messaging.sendT(from, CONFIG.TEMPLATES.ADD_CITY);

            case STATES.CLN_PRICE:
                await supabase.from('profiles').update({ pricing_info: msg, temp_state: STATES.CLN_BIO }).eq('phone_number', from);
                return Messaging.sendMsg(from, "כמעט סיימנו! ספר/י על עצמך בקצרה:");

            case STATES.CLN_BIO:
                await supabase.from('profiles').update({ bio: msg, temp_state: STATES.CLN_READY }).eq('phone_number', from);
                return Messaging.sendMsg(from, "הפרופיל מוכן! ✨");
        }
    },

    // === לקוח ===
    async client(from, profile, msg) {
        const state = profile.temp_state;
        console.log(`[Client Flow] State: ${state}, Msg: ${msg}`);

        // 1. בחירת זוכה
        const { data: jobAwaiting } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'awaiting_selection').single();
        if (jobAwaiting && /^\d+$/.test(msg)) {
            const { data: bids } = await supabase.rpc('get_job_bids', { p_job_id: jobAwaiting.id });
            const choice = parseInt(msg) - 1;
            
            if (!bids[choice]) return Messaging.sendMsg(from, "מספר לא תקין.");
            
            const sel = bids[choice];
            const { data: res } = await supabase.rpc('select_winner', { p_job_id: jobAwaiting.id, p_bid_id: sel.bid_id, p_client_phone: from });
            
            if (res[0].success) {
                await Messaging.sendMsg(from, `בשעה טובה! 🎉\nפרטי המנקה:\nטלפון: ${sel.cleaner_phone.replace('whatsapp:', '')}\nשם: ${sel.full_name}`);
                await Messaging.sendMsg(sel.cleaner_phone, `מזל טוב! נבחרת לעבודה! 🎉\nצרי קשר: ${from.replace('whatsapp:', '')}`);
            }
            return;
        }

        // 2. תהליך הזמנה
        if (msg.includes('תיאום') || msg === 'תיאום מנקה') {
            await supabase.from('jobs').insert([{ client_phone: from, status: 'draft', city: profile.city }]); 
            await supabase.from('profiles').update({ temp_state: STATES.CLI_DAY }).eq('phone_number', from);
            return Messaging.sendT(from, CONFIG.TEMPLATES.SELECT_DAY);
        }

        switch (state) {
            case STATES.CLI_DAY:
                const dayIndex = CONFIG.DAYS.indexOf(msg);
                if (dayIndex === -1) return Messaging.sendMsg(from, "נא לבחור יום מהרשימה.");
                
                const targetDate = new Date();
                targetDate.setDate(targetDate.getDate() + (dayIndex + 7 - targetDate.getDay()) % 7);
                const dateStr = targetDate.toISOString().split('T')[0];
                
                await supabase.from('jobs').update({ job_date: dateStr }).eq('client_phone', from).eq('status', 'draft');
                await supabase.from('profiles').update({ temp_state: STATES.CLI_TIME }).eq('phone_number', from);
                return Messaging.sendMsg(from, `באיזו שעה ב${msg}? (למשל: 09:00)`);

            case STATES.CLI_TIME:
                const { data: draft } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'draft').single();
                if (!draft) return Messaging.sendMsg(from, "אירעה שגיאה. נא להתחיל מחדש.");

                await supabase.from('jobs').update({ job_time: msg, status: 'pending' }).eq('id', draft.id);
                await supabase.from('profiles').update({ temp_state: STATES.CLI_READY }).eq('phone_number', from);
                
                // שידור המוני עם Promise.allSettled
                const { data: cleaners } = await supabase.from('profiles').select('phone_number, city').eq('role', 'cleaner');
                const matched = cleaners.filter(c => c.city && c.city.includes(draft.city)).map(c => c.phone_number);
                
                if (matched.length > 0) {
                    await supabase.from('profiles').update({ current_job_id: draft.id }).in('phone_number', matched);
                    
                    const results = await Promise.allSettled(
                        matched.map(p => Messaging.sendT(p, CONFIG.TEMPLATES.JOB_OFFER, { "1": draft.city, "2": msg }))
                    );
                    
                    const successCount = results.filter(r => r.status === 'fulfilled').length;
                    return Messaging.sendMsg(from, `בקשתך נקלטה! שלחנו הודעה ל-${successCount} מנקיות באזורך.`);
                } else {
                    return Messaging.sendMsg(from, "כרגע אין מנקיות פנויות באזור הזה.");
                }
        }
    }
};

// ==================== Webhook ראשי ====================

app.post('/whatsapp', validateTwilio, async (req, res) => {
    const msg = (req.body.Body || "").trim();
    const from = req.body.From;

    try {
        const { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();

        if (!profile) {
            if (msg === 'לקוח' || msg === 'מנקה') {
                await supabase.from('profiles').insert([{ 
                    phone_number: from, 
                    role: msg === 'לקוח' ? 'client' : 'cleaner', 
                    temp_state: STATES.REG_NAME 
                }]);
                return Messaging.sendMsg(from, "ברוכים הבאים! איך קוראים לך? (שם מלא)");
            }
            return Messaging.sendT(from, CONFIG.TEMPLATES.CHOOSE_ROLE);
        }

        if (profile.temp_state === STATES.REG_NAME) {
            const nextState = profile.role === 'cleaner' ? STATES.CLN_CITY : STATES.CLI_READY;
            await supabase.from('profiles').update({ full_name: msg, temp_state: nextState }).eq('phone_number', from);
            return Messaging.sendT(from, profile.role === 'cleaner' ? CONFIG.TEMPLATES.CLEANER_CITY : CONFIG.TEMPLATES.CLIENT_MENU);
        }

        // הפרדה מלאה לניתוב
        if (profile.role === 'cleaner') await Handlers.cleaner(from, profile, msg);
        else await Handlers.client(from, profile, msg);

        res.status(200).send('OK');

    } catch (e) { 
        console.error(`[Fatal Error] ${e.message}`); 
        res.status(200).send('OK'); 
    }
});

app.get('/cron/cleanup', async (req, res) => {
    if (req.headers['x-cron-secret'] !== CONFIG.CRON_SECRET) return res.status(403).send('Forbidden');
    
    const { data: expired } = await supabase.from('jobs')
        .select('*')
        .eq('status', 'collecting_bids')
        .lt('bid_deadline', new Date().toISOString());

    if (expired && expired.length > 0) {
        console.log(`[Cron] Processing ${expired.length} expired jobs`);
        for (const j of expired) {
            await Auction.closeAndNotify(j.id, j.client_phone);
        }
    }
    
    res.json({ processed: expired?.length || 0 });
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 CleanMatch v21.5 - Production Ready'));
