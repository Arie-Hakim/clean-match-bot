const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- פונקציות עזר ---

async function sendTemplate(to, contentSid, variables = {}) {
    console.log(`[Twilio] שולח תבנית ${contentSid} ל-${to} עם משתנים:`, variables);
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886', // מספר הסנדבוקס שלך
            to: to,
            contentSid: contentSid,
            contentVariables: JSON.stringify(variables)
        });
        console.log(`[Twilio] נשלח בהצלחה ל-${to}`);
    } catch (error) {
        console.error(`[Twilio Error] שגיאה בשליחה ל-${to}:`, error.message);
    }
}

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;

    console.log(`\n[Log] הודעה מ-${from}: "${incomingMsg}"`);

    try {
        let { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();

        // 1. שלב אישור לקוחה סופי (Privacy Match)
        if (profile?.role === 'client' && incomingMsg === 'approve_match') {
            console.log(`[Logic] הלקוחה ${from} אישרה את המנקה.`);
            const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'pending_approval').order('created_at', { ascending: false }).limit(1).single();
            if (job) {
                await supabase.from('jobs').update({ status: 'confirmed' }).eq('id', job.id);
                const { data: cleaner } = await supabase.from('profiles').select('*').eq('phone_number', job.cleaner_phone).single();
                
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `מעולה! התיאום נסגר. 📞 הטלפון של ${cleaner.full_name} הוא: ${cleaner.phone_number}` });
                await client.messages.create({ from: 'whatsapp:+14155238886', to: cleaner.phone_number, body: `הלקוחה אישרה! 🎉 הטלפון של ${profile.full_name} הוא: ${from}\nכתבי "סיימתי" בסיום העבודה.` });
                return res.status(200).send('OK');
            }
        }

        // 2. רישום וניהול פרופיל
        if (!profile) {
            console.log(`[Registration] משתמש חדש: ${from}`);
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ברוך הבא! 🎉 איך קוראים לך? (שם מלא)" });
            } else {
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc'); // תבנית בחירת תפקיד
            }
        } 
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            await sendTemplate(from, 'HX232d288f7201dcedae6c483b80692b9d'); // רשימת בחירת עיר (List Picker)
        }
        else if (!profile.city) {
            // שמירת העיר שנבחרה מהרשימה
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            console.log(`[Registration] עיר נבחרה עבור ${from}: ${incomingMsg}`);
            profile.role === 'client' ? await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa') : await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מה המחיר לשעה שלך בשקלים? (מספר בלבד)" });
        }
        else if (profile.role === 'cleaner' && !profile.hourly_rate) {
            await supabase.from('profiles').update({ hourly_rate: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "כמה דמי נסיעות את/ה גובה? (0 אם כלול)" });
        }
        else if (profile.role === 'cleaner' && profile.travel_fee === null) {
            await supabase.from('profiles').update({ travel_fee: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ספר/י על עצמך במשפט אחד (ניסיון וכו')." });
        }
        else if (profile.role === 'cleaner' && !profile.bio) {
            await supabase.from('profiles').update({ bio: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל מוכן! נשלח הודעה כשתהיה עבודה בעיר שלך. ✨" });
        }

        // 3. לוגיקת שידוך (Broadcasting & Matching)
        else {
            // א. לקוחה מבקשת ניקיון
            if (profile.role === 'client' && (incomingMsg.includes('ניקיון') || incomingMsg.includes('תיאום'))) {
                console.log(`[Matching] לקוחה ${from} מחפשת מנקה ב-${profile.city}`);
                await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'pending' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `🔎 מחפש מנקה ב${profile.city}...` });

                const { data: cleaners } = await supabase.from('profiles').select('phone_number').eq('role', 'cleaner').eq('city', profile.city);
                if (cleaners && cleaners.length > 0) {
                    console.log(`[Matching] נמצאו ${cleaners.length} מנקות בעיר.`);
                    cleaners.forEach(c => sendTemplate(c.phone_number, 'HXd2f1d5fe4e58f73b4edb85b2450fc1dc', { "1": profile.city }));
                } else {
                    console.log(`[Matching] לא נמצאו מנקות רשומות ב-${profile.city}`);
                }
            }
            // ב. מנקה מאשרת שהיא פנויה
            else if (profile.role === 'cleaner' && (incomingMsg === 'job_accept' || incomingMsg.includes('פנוי'))) {
                console.log(`[Matching] המנקה ${from} פנויה ב-${profile.city}`);
                const { data: job } = await supabase.from('jobs').select('*').eq('city', profile.city).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).single();
                
                if (job) {
                    await supabase.from('jobs').update({ cleaner_phone: from, status: 'pending_approval' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל שלך נשלח ללקוחה. מחכים לאישור שלה! ⏳" });
                    
                    // שליחת כרטיסיית האישור ללקוחה (עם פרטי המנקה)
                    await sendTemplate(job.client_phone, 'HX7aa935f1701a55ddf2bce2cce57bd12b', {
                        "1": profile.full_name,
                        "2": profile.hourly_rate.toString(),
                        "3": profile.travel_fee.toString(),
                        "4": profile.bio
                    });
                } else {
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "העבודה כבר נתפסה ע\"י מנקה אחרת." });
                }
            }
            // ג. סיום עבודה ודירוג
            else if (profile.role === 'cleaner' && incomingMsg.includes('סיימתי')) {
                const { data: job } = await supabase.from('jobs').select('*').eq('cleaner_phone', from).eq('status', 'confirmed').single();
                if (job) {
                    await supabase.from('jobs').update({ status: 'completed' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: job.client_phone, body: "הניקיון הסתיים! ✨ איך היה? דרג/י 1-5 (שלח/י מספר):" });
                }
            }
            // ד. תפריט ברירת מחדל
            else {
                if (profile.role === 'client') await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
                else await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ממתינים לעבודות... 🧹" });
            }
        }
    } catch (err) { console.error(`[CRITICAL ERROR]`, err); }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] CleanMatch 3.1 Live`));
