const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- פונקציות עזר חדשות ---

// 1. נורמליזציה של ערים: הופכת "פתח תקווה" ו"פתח תקוה" לזהים
function normalizeCity(city) {
    if (!city) return "";
    return city.trim()
        .replace(/יי/g, 'י')
        .replace(/וו/g, 'ו')
        .replace(/"/g, '')
        .replace(/'/g, '')
        .replace(/\s+/g, ' '); // ניקוי רווחים כפולים
}

// 2. שליחת תבניות Twilio
async function sendTemplate(to, contentSid, variables = {}) {
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886',
            to: to,
            contentSid: contentSid,
            contentVariables: JSON.stringify(variables)
        });
    } catch (error) {
        console.error('Template Error:', error);
    }
}

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;

    try {
        let { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();

        // --- לוגיקה ללקוחה: אישור מנקה ספציפית (השלב החדש) ---
        if (profile?.role === 'client' && incomingMsg === 'approve_match') {
            const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'pending_approval').order('created_at', { ascending: false }).limit(1).single();
            if (job) {
                await supabase.from('jobs').update({ status: 'confirmed' }).eq('id', job.id);
                const { data: cleaner } = await supabase.from('profiles').select('*').eq('phone_number', job.cleaner_phone).single();
                
                // עכשיו ורק עכשיו - חושפים טלפונים
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `מעולה! התיאום נסגר. 📞 הטלפון של ${cleaner.full_name} הוא: ${cleaner.phone_number}` });
                await client.messages.create({ from: 'whatsapp:+14155238886', to: cleaner.phone_number, body: `הלקוחה אישרה! 🎉 הטלפון של ${profile.full_name} הוא: ${from}\nכתבי "סיימתי" בסיום העבודה.` });
                return res.status(200).send('OK');
            }
        }

        // --- רישום וניהול פרופיל ---
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ברוך הבא! 🎉 איך קוראים לך? (שם מלא)" });
            } else {
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc');
            }
        } 
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "באיזו עיר את/ה גר/ה?" });
        }
        else if (!profile.city) {
            const cleanCity = normalizeCity(incomingMsg);
            await supabase.from('profiles').update({ city: cleanCity }).eq('phone_number', from);
            if (profile.role === 'client') {
                await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
            } else {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מה המחיר לשעה שלך? (מספר בלבד)" });
            }
        }
        // ... (המשך שאלות מנקה: מחיר, נסיעות, ביו - נשאר כפי שהיה)

        // --- לוגיקת שידוך ופרטיות ---
        else {
            // לקוחה מבקשת ניקיון
            if (profile.role === 'client' && (incomingMsg.includes('ניקיון') || incomingMsg.includes('תיאום'))) {
                await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'pending' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `🔎 מחפש מנקה ב${profile.city}...` });

                const { data: cleaners } = await supabase.from('profiles').select('phone_number').eq('role', 'cleaner').eq('city', profile.city);
                if (cleaners) {
                    cleaners.forEach(c => sendTemplate(c.phone_number, 'HXd2f1d5fe4e58f73b4edb85b2450fc1dc', { "1": profile.city }));
                }
            }
            // מנקה מאשרת שהיא פנויה
            else if (profile.role === 'cleaner' && (incomingMsg === 'job_accept' || incomingMsg.includes('פנוי'))) {
                const { data: job } = await supabase.from('jobs').select('*').eq('city', profile.city).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).single();
                if (job) {
                    // עדכון שהמנקה מעוניינת, אבל הסטטוס ממתין לאישור הלקוחה
                    await supabase.from('jobs').update({ cleaner_phone: from, status: 'pending_approval' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הצגת הפרופיל שלך נשלחה ללקוחה. מחכים לאישור שלה! ⏳" });
                    
                    // שליחת תבנית האישור החדשה ללקוחה
                    await sendTemplate(job.client_phone, 'HX7aa935f1701a55ddf2bce2cce57bd12b', {
                        "1": profile.full_name,
                        "2": profile.hourly_rate.toString(),
                        "3": profile.travel_fee.toString(),
                        "4": profile.bio
                    });
                } else {
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מצטערים, העבודה כבר נתפסה. נעדכן בפעם הבאה!" });
                }
            }
            // ... (לוגיקה לסיום עבודה ודירוג - נשארת זהה)
        }
    } catch (err) { console.error(err); }
    res.status(200).send('OK');
});

app.listen(process.env.PORT || 3000);
