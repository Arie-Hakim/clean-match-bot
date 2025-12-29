const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// 🟢 אבטחה: Rate Limiting
app.use('/whatsapp', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use('/cron', rateLimit({ windowMs: 60 * 1000, max: 10 }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// 🟢 אבטחה: אימות Twilio
const validateTwilio = (req, res, next) => {
    const signature = req.headers['x-twilio-signature'];
    const url = (process.env.WEBHOOK_URL || '') + req.originalUrl;
    if (process.env.NODE_ENV !== 'production' || twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) return next();
    res.status(403).send('Forbidden');
};

const CONFIG = {
    TWILIO_NUMBER: 'whatsapp:+14155238886',
    CRON_SECRET: process.env.CRON_SECRET || 'secure-cron-key',
    FIRST_BATCH_MINUTES: 2,
    MAX_BIDS_LIMIT: 5,
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

const STATES = { NEW: 'new', NAME: 'name', CITY: 'city', PRICING: 'pricing', BIO: 'bio', READY: 'ready', DAY: 'day', TIME: 'time', BID_PRICE: 'bid_price' };

// ==================== שירותי עזר (SERVICES) ====================

const Messaging = {
    async sendMsg(to, body) {
        console.log(`[Messaging] Text to ${to}`);
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, body }); } catch (e) { console.error(e.message); }
    },
    async sendT(to, sid, vars = {}) {
        console.log(`[Messaging] Template ${sid} to ${to}`);
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, contentSid: sid, contentVariables: JSON.stringify(vars) }); } catch (e) { console.error(e.message); }
    }
};

const Auction = {
    async closeAndNotify(jobId, clientPhone) {
        const { data: bids } = await supabase.rpc('get_job_bids', { p_job_id: jobId });
        if (!bids || bids.length === 0) {
            await supabase.from('jobs').update({ status: 'cancelled' }).eq('id', jobId);
            return Messaging.sendMsg(clientPhone, "😔 לא נמצאו מנקות פנויות לעבודה שלך.");
        }
        let msg = `מצאנו עבורך ${bids.length} הצעות! 🎉\n\n`;
        bids.forEach((b, i) => msg += `${i + 1}️⃣ *${b.full_name}*\n⭐ ${b.rating} (${b.total_jobs})\n💰 הצעה: ${b.bid_price}\n📝 "${b.bio}"\n\n`);
        msg += `לבחירה: שלח/י מספר (1-${bids.length})`;
        await Messaging.sendMsg(clientPhone, msg);
        await supabase.from('jobs').update({ status: 'awaiting_selection' }).eq('id', jobId);
    }
};

// ==================== מנהלי לוגיקה (HANDLERS) ====================

const Handlers = {
    async cleaner(from, profile, msg) {
        const jobId = profile.current_job_id;
        // 1. הגשת מחיר (Input Validation)
        if (profile.temp_state === STATES.BID_PRICE && jobId) {
            if (!/\d/.test(msg)) return Messaging.sendMsg(from, "נא להזין מחיר ברור (למשל: 350 שח)");
            const { data: r } = await supabase.rpc('submit_bid', { p_job_id: jobId, p_cleaner_phone: from, p_price: msg });
            await supabase.from('profiles').update({ temp_state: null, current_job_id: null }).eq('phone_number', from);
            if (!r[0].success) return Messaging.sendMsg(from, "המכרז נסגר 🙏");
            await Messaging.sendMsg(from, "ההצעה נשלחה! נחזור אליך.");
            if (r[0].bid_count === 1) await supabase.from('jobs').update({ bid_deadline: new Date(Date.now() + CONFIG.FIRST_BATCH_MINUTES * 60000).toISOString() }).eq('id', jobId);
            if (r[0].bid_count >= CONFIG.MAX_BIDS_LIMIT) await Auction.closeAndNotify(jobId, (await supabase.from('jobs').select('client_phone').eq('id', jobId).single()).data.client_phone);
            return true;
        }
        if (msg === 'job_accept' || msg === 'אני פנוי/ה') {
            if (!jobId) return Messaging.sendMsg(from, "העבודה כבר לא זמינה.");
            await supabase.from('profiles').update({ temp_state: STATES.BID_PRICE }).eq('phone_number', from);
            await Messaging.sendMsg(from, "מה הצעת המחיר שלך?");
            return true;
        }
        return false;
    },

    async client(from, profile, msg, draft) {
        const { data: jobAwaiting } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'awaiting_selection').single();
        // 2. בחירת מנקה (Index Guard)
        if (jobAwaiting && /^\d+$/.test(msg)) {
            const choice = parseInt(msg);
            const { data: bids } = await supabase.rpc('get_job_bids', { p_job_id: jobAwaiting.id });
            const sel = bids?.[choice - 1];
            if (!sel) return Messaging.sendMsg(from, `בחירה לא תקינה. נא לבחור בין 1 ל-${bids?.length || 0}`);
            const { data: res } = await supabase.rpc('select_winner', { p_job_id: jobAwaiting.id, p_bid_id: sel.bid_id, p_client_phone: from });
            if (res[0].success) {
                await Messaging.sendMsg(from, `סגרנו! 🎉 טלפון של ${sel.full_name}: ${sel.cleaner_phone.replace('whatsapp:', '')}`);
                await Messaging.sendMsg(sel.cleaner_phone, `הלקוחה בחרה בך! 🎉 צרי קשר: ${from.replace('whatsapp:', '')}`);
            }
            return true;
        }
        // 3. הפצת עבודה (Promise.all - Performance)
        if (draft && !draft.job_time && msg.length > 2) {
            await supabase.from('jobs').update({ job_time: msg, status: 'pending' }).eq('id', draft.id);
            const { data: clns } = await supabase.from('profiles').select('phone_number, city').eq('role', 'cleaner');
            const matched = clns.filter(c => c.city?.includes(draft.city)).map(c => c.phone_number);
            if (matched.length > 0) {
                await supabase.from('profiles').update({ current_job_id: draft.id }).in('phone_number', matched);
                await Promise.all(matched.map(p => Messaging.sendT(p, CONFIG.TEMPLATES.JOB_OFFER, { "1": draft.city, "2": msg })));
            }
            await Messaging.sendMsg(from, "מחפשת מנקות... נחזור אליך עם הצעות.");
            return true;
        }
        return false;
    }
};

// ==================== ENDPOINTS (WEBHOOK & CRON) ====================

app.get('/cron/cleanup', async (req, res) => {
    if (req.headers['x-cron-secret'] !== CONFIG.CRON_SECRET) return res.status(403).send('Forbidden');
    const { data: expired } = await supabase.from('jobs').select('*').eq('status', 'collecting_bids').lt('bid_deadline', new Date().toISOString());
    if (expired) for (const j of expired) await Auction.closeAndNotify(j.id, j.client_phone);
    res.status(200).send({ processed: expired?.length || 0 });
});

app.post('/whatsapp', validateTwilio, async (req, res) => {
    const msg = (req.body.Body || "").trim();
    const from = req.body.From;
    try {
        const { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();
        let handled = false;
        if (profile?.role === 'cleaner') handled = await Handlers.cleaner(from, profile, msg);
        if (!handled && profile?.role === 'client') {
            const { data: drft } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'draft').single();
            handled = await Handlers.client(from, profile, msg, drft);
        }
        if (handled) return res.status(200).send('OK');

        // State Machine - Registration
        let state = !profile ? STATES.NEW : !profile.full_name ? STATES.NAME : !profile.city ? STATES.CITY : STATES.READY;
        if (profile?.role === 'client' && state === STATES.READY) {
            const { data: drft } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'draft').single();
            if (drft) state = !drft.job_date ? STATES.DAY : STATES.TIME;
        }

        switch (state) {
            case STATES.NEW:
                if (msg === 'לקוח' || msg === 'מנקה') {
                    await supabase.from('profiles').insert([{ phone_number: from, role: msg === 'לקוח' ? 'client' : 'cleaner' }]);
                    await Messaging.sendMsg(from, "ברוכים הבאים! איך קוראים לך?");
                } else await Messaging.sendT(from, CONFIG.TEMPLATES.CHOOSE_ROLE);
                break;
            case STATES.CITY:
                const c = profile.city ? `${profile.city}, ${msg}` : msg;
                await supabase.from('profiles').update({ city: c }).eq('phone_number', from); // תיקון phone_number
                await Messaging.sendT(from, profile.role === 'cleaner' ? CONFIG.TEMPLATES.ADD_CITY : CONFIG.TEMPLATES.CLIENT_MENU);
                break;
            case STATES.READY:
                if (msg.includes('תיאום')) {
                    await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'draft' }]);
                    await Messaging.sendT(from, CONFIG.TEMPLATES.SELECT_DAY);
                }
                break;
        }
        res.status(200).send('OK');
    } catch (e) { console.error(e); res.status(200).send('OK'); }
});

function getNextDate(dayName) {
    const target = CONFIG.DAYS.indexOf(dayName);
    if (target === -1) return null;
    const d = new Date();
    d.setDate(d.getDate() + (target + 7 - d.getDay()) % 7);
    return d.toISOString().split('T')[0];
}

app.listen(process.env.PORT || 3000, () => console.log('🚀 CleanMatch Ultimate 13.0 Live'));
