const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// אבטחה: אימות טוויליו
const validateTwilio = (req, res, next) => {
    const signature = req.headers['x-twilio-signature'];
    const url = (process.env.WEBHOOK_URL || '').trim() + req.originalUrl;
    if (process.env.NODE_ENV !== 'production' || twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) return next();
    res.status(403).send('Forbidden');
};

const CONFIG = {
    TWILIO_NUMBER: 'whatsapp:+14155238886',
    CRON_SECRET: process.env.CRON_SECRET,
    TEMPLATES: {
        CHOOSE_ROLE: 'HXcde09f46bc023aa95fd7bb0a705fa2dc',
        CLEANER_CITY: 'HXd9def526bc4c9013994cfe6a3b0d4898',
        ADD_CITY: 'HX562db4f76686ae94f9827ba35d75a1cd',
        PRICING: 'HX...', // תבנית תמחור אם יש, או טקסט חופשי
        BIO: 'HX...',     // תבנית ביו
        CLIENT_MENU: 'HX3ae58035fa14b0f81c94e98093b582fa'
    }
};

const STATES = { NEW: 'new', NAME: 'name', CITY: 'city', PRICING: 'pricing', BIO: 'bio', READY: 'ready' };

const Messaging = {
    async sendMsg(to, body) {
        await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, body });
    },
    async sendT(to, sid, vars = {}) {
        await twilioClient.messages.create({ from: CONFIG.TWILIO_NUMBER, to, contentSid: sid, contentVariables: JSON.stringify(vars) });
    }
};

app.post('/whatsapp', validateTwilio, async (req, res) => {
    const msg = (req.body.Body || "").trim();
    const from = req.body.From;

    try {
        const { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();

        // 🟢 חישוב המצב הנוכחי לפי temp_state (פתרון לקפיצה שראינו)
        let state = STATES.NEW;
        if (profile) {
            state = profile.temp_state || (profile.full_name ? (profile.city ? STATES.READY : STATES.CITY) : STATES.NAME);
        }

        console.log(`[Flow] User: ${from}, Current State: ${state}, Msg: ${msg}`);

        switch (state) {
            case STATES.NEW:
                if (msg === 'מנקה' || msg === 'לקוח') {
                    await supabase.from('profiles').insert([{ phone_number: from, role: msg === 'מנקה' ? 'cleaner' : 'client', temp_state: STATES.NAME }]);
                    await Messaging.sendMsg(from, "איך קוראים לך? (שם מלא)");
                } else await Messaging.sendT(from, CONFIG.TEMPLATES.CHOOSE_ROLE);
                break;

            case STATES.NAME:
                await supabase.from('profiles').update({ full_name: msg, temp_state: STATES.CITY }).eq('phone_number', from);
                await Messaging.sendT(from, profile?.role === 'client' ? CONFIG.TEMPLATES.CLIENT_MENU : CONFIG.TEMPLATES.CLEANER_CITY);
                break;

            case STATES.CITY:
                // 1. המשתמש לחץ "כן" - נשארים באותו מצב ושולחים שוב את רשימת הערים
                if (msg === 'כן' || msg === 'Yes') {
                    return Messaging.sendT(from, CONFIG.TEMPLATES.CLEANER_CITY);
                }

                // 2. המשתמש לחץ "לא" - מעדכנים סטטוס ועוברים לתמחור
                if (msg === 'לא' || msg === 'No' || msg === 'זהו') {
                    await supabase.from('profiles').update({ temp_state: STATES.PRICING }).eq('phone_number', from);
                    return Messaging.sendMsg(from, "מעולה. מה המחיר הממוצע שלך לשעה? (למשל: 80₪)");
                }

                // 3. המשתמש בחר עיר מהרשימה - מוסיפים ושואלים "עוד?"
                const updatedCities = profile.city ? `${profile.city}, ${msg}` : msg;
                await supabase.from('profiles').update({ city: updatedCities }).eq('phone_number', from);
                await Messaging.sendT(from, CONFIG.TEMPLATES.ADD_CITY);
                break;

            case STATES.PRICING:
                await supabase.from('profiles').update({ pricing_info: msg, temp_state: STATES.BIO }).eq('phone_number', from);
                await Messaging.sendMsg(from, "ספר/י על עצמך בקצרה (ניסיון, המלצות):");
                break;

            case STATES.BIO:
                await supabase.from('profiles').update({ bio: msg, temp_state: STATES.READY }).eq('phone_number', from);
                await Messaging.sendMsg(from, "הפרופיל שלך מוכן! ✨ נעדכן אותך כשתהיה עבודה רלוונטית.");
                break;

            case STATES.READY:
                // לוגיקה רגילה של תיאום עבודה או קבלת עבודה
                break;
        }
        res.status(200).send('OK');
    } catch (e) { console.error(e); res.status(200).send('OK'); }
});

app.listen(process.env.PORT || 3000);
