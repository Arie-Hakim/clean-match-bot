const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- רשימת SIDs סופית ומאושרת ---
const SIDS = {
    CHOOSE_ROLE: 'HXcde09f46bc023aa95fd7bb0a705fa2dc',
    CLIENT_CITY: 'HX232d288f7201dcedae6c483b80692b9d',
    CLEANER_CITY: 'HXd9def526bc4c9013994cfe6a3b0d4898',
    ADD_CITY_PROMPT: 'HX562db4f76686ae94f9827ba35d75a1cd',
    CLIENT_MENU: 'HX3ae58035fa14b0f81c94e98093b582fa',
    SELECT_DAY: 'HX69270232323e170ed106fd8e01395ed4', 
    JOB_OFFER: 'HXef6e04eba99339e6a96a071cf7aa279b',  
    APPROVE_CARD: 'HX7aa935f1701a55ddf2bce2cce57bd12b'
};

// --- פונקציות עזר לוגיות ---

function getNextDateOfDay(dayName) {
    const daysHebrew = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "מוצאי שבת"];
    const targetDay = daysHebrew.indexOf(dayName);
    if (targetDay === -1) return null;
    const now = new Date();
    const resultDate = new Date();
    resultDate.setDate(now.getDate() + (targetDay + 7 - now.getDay()) % 7);
    return resultDate.toISOString().split('T')[0];
}

async function sendTemplate(to, contentSid, variables = {}) {
    console.log(`[Twilio Log] שולח ${contentSid} ל-${to}. משתנים:`, variables);
    try {
        await client.messages.create({ from: 'whatsapp:+14155238886', to: to, contentSid: contentSid, contentVariables: JSON.stringify(variables) });
    } catch (e) { console.error(`[Twilio Error] שגיאה בשליחה:`, e.message); }
}

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;

    console.log(`\n--- הודעה חדשה מ: ${from} | תוכן: "${incomingMsg}" ---`);

    try {
        let { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();

        // 1. חשיפת פרטים הדדית לאחר אישור לקוחה (Privacy Flow)
        if (profile?.role === 'client' && incomingMsg === 'approve_match') {
            console.log(`[Flow] לקוחה אישרה מנקה. מחפש ג'וב ב-pending_approval.`);
            const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'pending_approval').order('created_at', { ascending: false }).limit(1).single();
            if (job) {
                await supabase.from('jobs').update({ status: 'confirmed' }).eq('id', job.id);
                const { data: cleaner } = await supabase.from('profiles').select('*').eq('phone_number', job.cleaner_phone).single();
                const cleanCleaner = cleaner.phone_number.replace('whatsapp:', '');
                const cleanClient = from.replace('whatsapp:', '');

                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `סגרנו! 🎉 הטלפון של המנקה ${cleaner.full_name} הוא: ${cleanCleaner}\nתתחדשו! ✨` });
                await client.messages.create({ from: 'whatsapp:+14155238886', to: job.cleaner_phone, body: `הלקוחה אישרה! 🎉 הטלפון של ${profile.full_name} הוא: ${cleanClient}\nצרי קשר לתיאום.` });
                return res.status(200).send('OK');
            }
        }

        // 2. ריבוי ערים למנקה
        if (profile?.role === 'cleaner' && incomingMsg === 'yes_another_city') {
            await sendTemplate(from, SIDS.CLEANER_CITY);
            return res.status(200).send('OK');
        }

        // 3. רישום פרופיל (שם, ערים, מחיר, נסיעות, ביו)
        if (!profile) {
            console.log(`[Registration] מתחיל רישום למספר ${from}`);
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "נעים מאוד! איך קוראים לך? (שם מלא)" });
            } else { await sendTemplate(from, SIDS.CHOOSE_ROLE); }
        } 
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            profile.role === 'client' ? await sendTemplate(from, SIDS.CLIENT_CITY) : await sendTemplate(from, SIDS.CLEANER_CITY);
        }
        else if (!profile.city || (profile.role === 'cleaner' && !profile.hourly_rate && (["כן", "לא", "yes_another_city", "no_more_cities"].includes(incomingMsg) || incomingMsg.length > 3))) {
            const isCityInList = ["פתח תקווה", "תל אביב", "ראשון לציון", "רמת גן", "חולון", "בני ברק", "גבעתיים", "הרצליה", "רעננה", "הוד השרון", "כפר סבא"].includes(incomingMsg);
            
            if (isCityInList) {
                const currentCities = profile.city ? `${profile.city}, ${incomingMsg}` : incomingMsg;
                await supabase.from('profiles').update({ city: currentCities }).eq('phone_number', from);
                profile.role === 'cleaner' ? await sendTemplate(from, SIDS.ADD_CITY_PROMPT) : await sendTemplate(from, SIDS.CLIENT_MENU);
            } else if (incomingMsg === 'no_more_cities') {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מה המחיר לשעה שלך בשקלים? (מספר בלבד)" });
            }
        }
        // השלמת רישום מנקה (מחיר -> נסיעות -> ביו)
        else if (profile.role === 'cleaner' && !profile.hourly_rate) {
            await supabase.from('profiles').update({ hourly_rate: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "דמי נסיעות? (0 אם כלול במחיר)" });
        }
        else if (profile.role === 'cleaner' && profile.travel_fee === null) {
            await supabase.from('profiles').update({ travel_fee: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ספר/י על עצמך במשפט אחד (ניסיון וכו'):" });
        }
        else if (profile.role === 'cleaner' && !profile.bio) {
            await supabase.from('profiles').update({ bio: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל מוכן! נעדכן אותך כשתהיה עבודה. ✨" });
        }

        // 4. לוגיקת שידוך עם מועד (Draft -> Date -> Time -> Pending)
        else if (profile.role === 'client') {
            const { data: draftJob } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'draft').single();

            if (incomingMsg.includes('תיאום')) {
                console.log(`[Flow] לקוחה התחילה תיאום.`);
                await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'draft' }]);
                await sendTemplate(from, SIDS.SELECT_DAY); 
            }
            else if (draftJob && !draftJob.job_date) {
                const absDate = getNextDateOfDay(incomingMsg);
                await supabase.from('jobs').update({ job_date: absDate }).eq('id', draftJob.id);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `נקבע ל${incomingMsg} (${absDate.split('-').reverse().join('/')}). באיזו שעה נוח לך?` });
            }
            else if (draftJob && draftJob.job_date && !draftJob.job_time) {
                console.log(`[Flow] ג'וב הושלם. מפיץ למנקות ב-${profile.city}.`);
                await supabase.from('jobs').update({ job_time: incomingMsg, status: 'pending' }).eq('id', draftJob.id);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "🔎 מחפש עבורך מנקה... אעדכן אותך מיד." });

                const { data: cleaners } = await supabase.from('profiles').select('*').eq('role', 'cleaner');
                const matches = cleaners.filter(c => c.city && c.city.includes(profile.city));
                const dateStr = draftJob.job_date.split('-').reverse().join('/');
                matches.forEach(c => sendTemplate(c.phone_number, SIDS.JOB_OFFER, { "1": profile.city, "2": `${dateStr} בשעה ${incomingMsg}` }));
            }
        }
        
        // 5. מנקה מאשרת פניות (Matching Logic)
        else if (profile.role === 'cleaner' && (incomingMsg === 'job_accept' || incomingMsg.includes('פנוי'))) {
            const { data: jobs } = await supabase.from('jobs').select('*').eq('status', 'pending');
            // מציאת ג'וב שמתאים לעיר של המנקה
            const matchingJob = jobs.find(j => profile.city.includes(j.city));
            
            if (matchingJob) {
                console.log(`[Match] מנקה ${from} תואמה לג'וב ${matchingJob.id}`);
                await supabase.from('jobs').update({ cleaner_phone: from, status: 'pending_approval' }).eq('id', matchingJob.id);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל נשלח ללקוחה. מחכים לאישורה! ⏳" });
                await sendTemplate(matchingJob.client_phone, SIDS.APPROVE_CARD, { "1": profile.full_name, "2": profile.hourly_rate.toString(), "3": profile.travel_fee.toString(), "4": profile.bio });
            }
        }
    } catch (err) { console.error(`[CRITICAL ERROR]`, err); }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanMatch 3.9 Live & Logging`));
