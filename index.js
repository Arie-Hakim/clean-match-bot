const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use('/whatsapp', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

if (!process.env.CRON_SECRET || !process.env.SUPABASE_URL) {
    console.error("❌ CRITICAL: Missing Environment Variables!");
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const CONFIG = {
    TWILIO_NUMBER: 'whatsapp:+14155238886',
    CRON_SECRET: process.env.CRON_SECRET,
    AUCTION_WAIT_MINUTES: 2, 
    BIDS_LIMIT: 5,           
    BATCH_SIZE: 10,
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

const STATES = {
    REG_NAME: 'reg_name',
    CLN_CITY: 'cln_city',
    CLN_PRICE: 'cln_price',
    CLN_BIO: 'cln_bio',
    CLN_READY: 'cln_ready',
    CLI_READY: 'cli_ready',
    CLI_CITY: 'cli_city',
    CLI_DAY: 'cli_day',
    CLI_TIME: 'cli_time'
};

// ==================== Utilities ====================

async function broadcastToCleaners(cleaners, template, vars) {
    console.log(`[Broadcast] Starting for ${cleaners.length} users...`);
    for (let i = 0; i < cleaners.length; i += CONFIG.BATCH_SIZE) {
        const chunk = cleaners.slice(i, i + CONFIG.BATCH_SIZE);
        await Promise.allSettled(chunk.map(phone => 
            twilioClient.messages.create({ 
                from: CONFIG.TWILIO_NUMBER, 
                to: phone, 
                contentSid: template, 
                contentVariables: JSON.stringify(vars) 
            })
        ));
        if (i + CONFIG.BATCH_SIZE < cleaners.length) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between batches
        }
    }
}

const Messaging = {
    async sendMsg(to, body) {
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, body }); } 
        catch (e) { console.error(`[Twilio Error] ${e.message}`); }
    },
    async sendT(to, sid, vars = {}) {
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, contentSid: sid, contentVariables: JSON.stringify(vars) }); } 
        catch (e) { console.error(`[Twilio Error] ${e.message}`); }
    }
};

const Auction = {
    async closeAndNotify(jobId, clientPhone) {
        const { data: bids } = await supabase.rpc('get_job_bids', { p_job_id: jobId });
        await supabase.from('profiles').update({ current_job_id: null }).eq('current_job_id', jobId);

        if (!bids || bids.length === 0) {
            await supabase.from('jobs').update({ status: 'cancelled' }).eq('id', jobId);
            return Messaging.sendMsg(clientPhone, "😔 לא נמצאו הצעות. נסה שוב מאוחר יותר.");
        }
        let msg = `מצאנו ${bids.length} הצעות עבורך! 🎉\n\n`;
        bids.forEach((b, i) => msg += `${i + 1}️⃣ *${b.full_name}*\n⭐ ${b.rating}\n💰 ${b.bid_price}₪\n📝 "${b.bio}"\n\n`);
        msg += `לבחירה, שלח/י את המספר.`;
        await Messaging.sendMsg(clientPhone, msg);
        await supabase.from('jobs').update({ status: 'awaiting_selection', selection_deadline: new Date(Date.now() + 24 * 60 * 60 * 1000) }).eq('id', jobId);
    }
};

const validateTwilio = (req, res, next) => {
    const signature = req.headers['x-twilio-signature'];
    const url = (process.env.WEBHOOK_URL || '').trim() + req.originalUrl;
    if (process.env.NODE_ENV === 'production' && !twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) {
        return res.status(403).send('Forbidden');
    }
    return next();
};

const Handlers = {
    async cleaner(from, profile, msg) {
        if (msg === 'סטטוס') {
             const status = profile.current_job_id ? "פעיל" : "פנוי";
             return Messaging.sendMsg(from, `מצב נוכחי: ${status}`);
        }
        if (msg === 'ביטול' || msg === 'בטל') {
            const { data: cancelled } = await supabase.rpc('cancel_bid', { p_cleaner_phone: from });
            if (cancelled) return Messaging.sendMsg(from, "✅ ההצעה בוטלה.");
            return Messaging.sendMsg(from, "לא נמצאה הצעה פעילה.");
        }

        const state = profile.temp_state;
        const jobId = profile.current_job_id;

        if (state === 'bid_price' && jobId) {
            const normalizedMsg = msg.replace(',', '.').replace(/[^0-9.]/g, '');
            const price = parseFloat(normalizedMsg);
            if (isNaN(price) || price <= 0) return Messaging.sendMsg(from, "נא להזין מחיר תקין.");
            
            const { data: r } = await supabase.rpc('submit_bid', { p_job_id: jobId, p_cleaner_phone: from, p_price: price });
            await supabase.from('profiles').update({ temp_state: STATES.CLN_READY }).eq('phone_number', from); 
            
            if (!r[0].success) return Messaging.sendMsg(from, "המכרז נסגר.");
            
            if (r[0].bid_count === 1) await supabase.from('jobs').update({ bid_deadline: new Date(Date.now() + CONFIG.AUCTION_WAIT_MINUTES * 60000).toISOString() }).eq('id', jobId);
            if (r[0].bid_count >= CONFIG.BIDS_LIMIT) {
                const { data: j } = await supabase.from('jobs').select('client_phone').eq('id', jobId).single();
                await Auction.closeAndNotify(jobId, j.client_phone);
            }
            return Messaging.sendMsg(from, "ההצעה נשלחה בהצלחה! 🤞");
        }

        if (msg === 'אני פנוי/ה' && jobId) {
            await supabase.from('profiles').update({ temp_state: 'bid_price' }).eq('phone_number', from);
            return Messaging.sendMsg(from, "מעולה! מה הצעת המחיר שלך?");
        }

        switch (state) {
            case STATES.CLN_CITY:
                if (msg === 'כן' || msg === 'Yes' || msg.includes('עוד ערים')) return Messaging.sendT(from, CONFIG.TEMPLATES.CLEANER_CITY);
                if (msg === 'לא' || msg === 'זהו' || msg === 'no_more_cities') {
                    await supabase.from('profiles').update({ temp_state: STATES.CLN_PRICE }).eq('phone_number', from);
                    return Messaging.sendMsg(from, "מה המחיר הממוצע לשעה? (למשל: 80₪)");
                } 
                const currentCities = profile.city || "";
                if (!currentCities.includes(msg)) {
                    const updated = currentCities ? `${currentCities}, ${msg}` : msg;
                    await supabase.from('profiles').update({ city: updated }).eq('phone_number', from);
                }
                return Messaging.sendT(from, CONFIG.TEMPLATES.ADD_CITY);

            case STATES.CLN_PRICE:
                await supabase.from('profiles').update({ pricing_info: msg, temp_state: STATES.CLN_BIO }).eq('phone_number', from);
                return Messaging.sendMsg(from, "ספר/י על עצמך בקצרה:");

            case STATES.CLN_BIO:
                await supabase.from('profiles').update({ bio: msg, temp_state: STATES.CLN_READY }).eq('phone_number', from);
                return Messaging.sendMsg(from, "הפרופיל שלך מוכן! את אלופה, תכף תהיה כאן עבודה בשבילך. ✨");
        }
    },

    async client(from, profile, msg) {
        if (msg === 'איפוס') {
             await supabase.from('jobs').update({ status: 'cancelled' }).eq('client_phone', from).eq('status', 'draft');
             await supabase.from('profiles').update({ temp_state: STATES.CLI_READY }).eq('phone_number', from);
             return Messaging.sendMsg(from, "איפסנו את התהליך. שלח 'תיאום מנקה' כדי להתחיל מחדש.");
        }
        
        const state = profile.temp_state;

        const { data: jobAwaiting } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'awaiting_selection').single();
        if (jobAwaiting && /^\d+$/.test(msg)) {
            const { data: bids } = await supabase.rpc('get_job_bids', { p_job_id: jobAwaiting.id });
            const choice = parseInt(msg) - 1;
            if (!bids[choice]) return Messaging.sendMsg(from, "מספר לא תקין.");
            
            const sel = bids[choice];
            const { data: res } = await supabase.rpc('select_winner', { p_job_id: jobAwaiting.id, p_bid_id: sel.bid_id, p_client_phone: from });
            
            if (res[0].success) {
                await Messaging.sendMsg(from, `פרטי המנקה:\nטלפון: ${sel.cleaner_phone.replace('whatsapp:', '')}\nשם: ${sel.full_name}`);
                await Messaging.sendMsg(sel.cleaner_phone, `נבחרת לעבודה! 🎉 צרי קשר: ${from.replace('whatsapp:', '')}`);
                
                // הודעה למפסידים
                const rejected = bids.filter(b => b.bid_id !== sel.bid_id);
                for (const r of rejected) {
                    await Messaging.sendMsg(r.cleaner_phone, "תודה על ההצעה, הפעם לא נבחרת. נשמח לראות אותך במכרזים הבאים! 💪");
                }
            }
            return;
        }

        if (msg.includes('תיאום') || msg === 'תיאום מנקה') {
            const { data: existing } = await supabase.from('jobs').select('*').eq('client_phone', from).in('status', ['draft', 'pending', 'collecting_bids']).single();
            if (existing) return Messaging.sendMsg(from, "יש לך כבר תהליך פעיל. שלח 'איפוס' אם נתקעת.");

            await supabase.from('jobs').delete().eq('client_phone', from).eq('status', 'draft');
            await supabase.from('jobs').insert([{ client_phone: from, status: 'draft' }]); 
            await supabase.from('profiles').update({ temp_state: STATES.CLI_CITY }).eq('phone_number', from);
            return Messaging.sendT(from, CONFIG.TEMPLATES.CLIENT_CITY);
        }

        switch (state) {
            case STATES.CLI_CITY:
                await supabase.from('jobs').update({ city: msg }).eq('client_phone', from).eq('status', 'draft');
                await supabase.from('profiles').update({ temp_state: STATES.CLI_DAY }).eq('phone_number', from);
                return Messaging.sendT(from, CONFIG.TEMPLATES.SELECT_DAY);

            case STATES.CLI_DAY:
                const dayIndex = CONFIG.DAYS.indexOf(msg);
                if (dayIndex === -1) return Messaging.sendMsg(from, "נא לבחור יום מהרשימה.");
                
                const now = new Date();
                let daysToAdd = (dayIndex - now.getDay() + 7) % 7;
                if (daysToAdd === 0) daysToAdd = 7;
                const targetDate = new Date();
                targetDate.setDate(now.getDate() + daysToAdd);
                
                await supabase.from('jobs').update({ job_date: targetDate.toISOString().split('T')[0] }).eq('client_phone', from).eq('status', 'draft');
                await supabase.from('profiles').update({ temp_state: STATES.CLI_TIME }).eq('phone_number', from);
                return Messaging.sendMsg(from, `באיזו שעה ב${msg}? (למשל: 09:00)`);

            case STATES.CLI_TIME:
                const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
                const normalizedTime = msg.trim().replace(/\s+/g, '');
                if (!timeRegex.test(normalizedTime)) return Messaging.sendMsg(from, "פורמט שעה לא ברור. נסה למשל: 09:00");

                const { data: draft } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'draft').single();
                if (!draft) return Messaging.sendMsg(from, "אירעה שגיאה. שלח 'איפוס'.");

                await supabase.from('jobs').update({ job_time: msg, status: 'pending' }).eq('id', draft.id);
                await supabase.from('profiles').update({ temp_state: STATES.CLI_READY }).eq('phone_number', from);
                
                const { data: cleaners } = await supabase.from('profiles').select('phone_number, city').eq('role', 'cleaner');
                const matched = cleaners.filter(c => c.city && c.city.includes(draft.city)).map(c => c.phone_number);
                
                if (matched.length > 0) {
                    await supabase.from('profiles').update({ current_job_id: draft.id }).in('phone_number', matched);
                    // חשוב: שימוש ב-await כדי שההודעה ללקוח תגיע אחרי שהתהליך התחיל
                    await broadcastToCleaners(matched, CONFIG.TEMPLATES.JOB_OFFER, { "1": draft.city, "2": msg });
                    return Messaging.sendMsg(from, `בקשתך נקלטה! הודעה נשלחה ל-${matched.length} מנקיות.`);
                } else {
                    return Messaging.sendMsg(from, `לא נמצאו מנקיות ב${draft.city} כרגע.`);
                }
        }
    }
};

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
                return Messaging.sendMsg(from, "ברוכים הבאים! איך קוראים לך?");
            }
            return Messaging.sendT(from, CONFIG.TEMPLATES.CHOOSE_ROLE);
        }

        if (profile.temp_state === STATES.REG_NAME) {
            if (profile.role === 'cleaner') {
                 await supabase.from('profiles').update({ full_name: msg, temp_state: STATES.CLN_CITY }).eq('phone_number', from);
                 return Messaging.sendT(from, CONFIG.TEMPLATES.CLEANER_CITY);
            } else {
                 await supabase.from('profiles').update({ full_name: msg, temp_state: STATES.CLI_READY }).eq('phone_number', from);
                 return Messaging.sendT(from, CONFIG.TEMPLATES.CLIENT_MENU);
            }
        }

        if (profile.role === 'cleaner') await Handlers.cleaner(from, profile, msg);
        else await Handlers.client(from, profile, msg);

        res.status(200).send('OK');
    } catch (e) { 
        console.error('[Webhook Error]', { message: e.message, from }); 
        res.status(200).send('OK'); 
    }
});

app.get('/cron/cleanup', async (req, res) => {
    if (req.headers['x-cron-secret'] !== CONFIG.CRON_SECRET) return res.status(403).send('Forbidden');
    
    // סגירת מכרזים
    const { data: expired } = await supabase.from('jobs').select('*').eq('status', 'collecting_bids').lt('bid_deadline', new Date().toISOString());
    if (expired) for (const j of expired) await Auction.closeAndNotify(j.id, j.client_phone);

    // ניקוי טיוטות ולוגים ישנים
    await supabase.from('jobs').delete().eq('status', 'draft').lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    await supabase.from('audit_logs').delete().lt('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());
    
    res.json({ processed: expired?.length || 0 });
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 CleanMatch v25.0 - Final'));
