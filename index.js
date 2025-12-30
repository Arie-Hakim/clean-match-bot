const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// אבטחה וניהול קצב
app.use('/whatsapp', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const CONFIG = {
    TWILIO_NUMBER: 'whatsapp:+14155238886',
    CRON_SECRET: process.env.CRON_SECRET || 'AryehMasterKey',
    AUCTION_WAIT_MINUTES: 2,
    BIDS_LIMIT: 5,
    TEMPLATES: {
        CHOOSE_ROLE: 'HXcde09f46bc023aa95fd7bb0a705fa2dc',
        CLEANER_CITY: 'HXd9def526bc4c9013994cfe6a3b0d4898',
        ADD_CITY: 'HX562db4f76686ae94f9827ba35d75a1cd',
        CLIENT_MENU: 'HX3ae58035fa14b0f81c94e98093b582fa',
        SELECT_DAY: 'HX69270232323e170ed106fd8e01395ed4',
        JOB_OFFER: 'HXef6e04eba99339e6a96a071cf7aa279b'
    },
    DAYS: ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "מוצאי שבת"]
};

// הפרדת סטטוסים ברורה
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

const Messaging = {
    async sendMsg(to, body) {
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, body }); } catch (e) { console.error(e.message); }
    },
    async sendT(to, sid, vars = {}) {
        try { await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, contentSid: sid, contentVariables: JSON.stringify(vars) }); } catch (e) { console.error(e.message); }
    }
};

const validateTwilio = (req, res, next) => {
    const signature = req.headers['x-twilio-signature'];
    const url = (process.env.WEBHOOK_URL || '').trim() + req.originalUrl;
    if (process.env.NODE_ENV !== 'production' || twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) return next();
    res.status(403).send('Forbidden');
};

// ==================== לוגיקה עסקית ====================

const Handlers = {
    async cleaner(from, profile, msg) {
        const state = profile.temp_state;
        const jobId = profile.current_job_id;

        console.log(`[Cleaner Flow] State: ${state}, Msg: ${msg}`);

        // הגשת הצעה
        if (state === 'bid_price' && jobId) {
            const price = parseFloat(msg.replace(/[^0-9.]/g, ''));
            if (isNaN(price)) return Messaging.sendMsg(from, "נא להזין מחיר במספר.");
            const { data: r } = await supabase.rpc('submit_bid', { p_job_id: jobId, p_cleaner_phone: from, p_price: price });
            await supabase.from('profiles').update({ temp_state: STATES.CLN_READY, current_job_id: null }).eq('phone_number', from);
            if (r[0].bid_count === 1) await supabase.from('jobs').update({ bid_deadline: new Date(Date.now() + CONFIG.AUCTION_WAIT_MINUTES * 60000).toISOString() }).eq('id', jobId);
            return Messaging.sendMsg(from, "ההצעה נשלחה! נעדכן אותך.");
        }

        switch (state) {
            case STATES.CLN_CITY:
                if (msg === 'כן' || msg === 'Yes') return Messaging.sendT(from, CONFIG.TEMPLATES.CLEANER_CITY);
                if (msg === 'לא' || msg === 'No' || msg === 'זהו') {
                    await supabase.from('profiles').update({ temp_state: STATES.CLN_PRICE }).eq('phone_number', from);
                    return Messaging.sendMsg(from, "מעולה. מה המחיר הממוצע שלך לשעה? (למשל: 80₪)");
                }
                const updated = profile.city ? `${profile.city}, ${msg}` : msg;
                await supabase.from('profiles').update({ city: updated }).eq('phone_number', from);
                return Messaging.sendT(from, CONFIG.TEMPLATES.ADD_CITY);

            case STATES.CLN_PRICE:
                await supabase.from('profiles').update({ pricing_info: msg, temp_state: STATES.CLN_BIO }).eq('phone_number', from);
                return Messaging.sendMsg(from, "ספר/י על עצמך בקצרה (ניסיון, המלצות):");

            case STATES.CLN_BIO:
                await supabase.from('profiles').update({ bio: msg, temp_state: STATES.CLN_READY }).eq('phone_number', from);
                return Messaging.sendMsg(from, "הפרופיל מוכן! ✨ נעדכן אותך כשתהיה עבודה.");
        }
        return false;
    },

    async client(from, profile, msg) {
        const state = profile.temp_state;
        console.log(`[Client Flow] State: ${state}, Msg: ${msg}`);

        // בחירת זוכה
        const { data: jobAwaiting } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'awaiting_selection').single();
        if (jobAwaiting && /^\d+$/.test(msg)) {
            // ... (לוגיקת בחירת מנקה מ-get_job_bids)
            return true;
        }

        if (msg.includes('תיאום')) {
            await supabase.from('jobs').insert([{ client_phone: from, status: 'draft', city: profile.city }]);
            await supabase.from('profiles').update({ temp_state: STATES.CLI_DAY }).eq('phone_number', from);
            return Messaging.sendT(from, CONFIG.TEMPLATES.SELECT_DAY);
        }

        switch (state) {
            case STATES.CLI_DAY:
                const dIdx = CONFIG.DAYS.indexOf(msg);
                if (dIdx === -1) return Messaging.sendMsg(from, "נא לבחור יום מהרשימה.");
                const dt = new Date(); dt.setDate(dt.getDate() + (dIdx + 7 - dt.getDay()) % 7);
                await supabase.from('jobs').update({ job_date: dt.toISOString().split('T')[0] }).eq('client_phone', from).eq('status', 'draft');
                await supabase.from('profiles').update({ temp_state: STATES.CLI_TIME }).eq('phone_number', from);
                return Messaging.sendMsg(from, `באיזו שעה ב${msg}?`);

            case STATES.CLI_TIME:
                const { data: draft } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'draft').single();
                await supabase.from('jobs').update({ job_time: msg, status: 'pending' }).eq('id', draft.id);
                await supabase.from('profiles').update({ temp_state: STATES.CLI_READY }).eq('phone_number', from);
                
                // הפצה (Promise.all)
                const { data: clns } = await supabase.from('profiles').select('phone_number, city').eq('role', 'cleaner');
                const matched = clns.filter(c => c.city?.includes(draft.city)).map(c => c.phone_number);
                if (matched.length > 0) {
                    await supabase.from('profiles').update({ current_job_id: draft.id }).in('phone_number', matched);
                    await Promise.all(matched.map(p => Messaging.sendT(p, CONFIG.TEMPLATES.JOB_OFFER, { "1": draft.city, "2": msg })));
                }
                return Messaging.sendMsg(from, "מחפשת מנקות... אעדכן אותך מיד.");
        }
        return false;
    }
};

// ==================== Main Webhook ====================

app.post('/whatsapp', validateTwilio, async (req, res) => {
    const msg = (req.body.Body || "").trim();
    const from = req.body.From;

    try {
        const { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();

        if (!profile) {
            if (msg === 'לקוח' || msg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: msg === 'לקוח' ? 'client' : 'cleaner', temp_state: STATES.REG_NAME }]);
                return Messaging.sendMsg(from, "נעים להכיר! איך קוראים לך?");
            }
            return Messaging.sendT(from, CONFIG.TEMPLATES.CHOOSE_ROLE);
        }

        if (profile.temp_state === STATES.REG_NAME) {
            const next = profile.role === 'cleaner' ? STATES.CLN_CITY : STATES.CLI_READY;
            await supabase.from('profiles').update({ full_name: msg, temp_state: next }).eq('phone_number', from);
            return Messaging.sendT(from, profile.role === 'cleaner' ? CONFIG.TEMPLATES.CLEANER_CITY : CONFIG.TEMPLATES.CLIENT_MENU);
        }

        if (profile.role === 'cleaner') await Handlers.cleaner(from, profile, msg);
        else await Handlers.client(from, profile, msg);

        res.status(200).send('OK');
    } catch (e) { console.error(e); res.status(200).send('OK'); }
});

app.get('/cron/cleanup', async (req, res) => {
    if (req.headers['x-cron-secret'] !== CONFIG.CRON_SECRET) return res.status(403).send('Forbidden');
    // ... (לוגיקת סגירת מכרזים ב-Auction.closeAndNotify)
    res.json({ status: 'done' });
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 CleanMatch v20.0 Ready'));
