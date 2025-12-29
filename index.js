const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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

        // 1. בדיקת שלב ביקורת (לקוח משאיר משפטים)
        const { data: openReview } = await supabase.from('reviews')
            .select('*').eq('client_phone', from).is('comment', null).order('created_at', { ascending: false }).limit(1).single();

        if (profile?.role === 'client' && openReview && isNaN(incomingMsg)) {
            await supabase.from('reviews').update({ comment: incomingMsg }).eq('id', openReview.id);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "תודה רבה! הביקורת נשמרה. 🙏" });
            return res.status(200).send('OK');
        }

        // 2. רישום משתמש חדש
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "נרשמת! איך קוראים לך? (שם מלא)" });
            } else {
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc');
            }
        } 
        // 3. איסוף פרטים (שם, עיר, מחיר וכו')
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "באיזו עיר את/ה גר/ה?" });
        }
        else if (!profile.city) {
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            if (profile.role === 'client') {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הרישום הסתיים! ✅" });
                await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
            } else {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מה המחיר לשעה שלך? (מספר בלבד)" });
            }
        }
        else if (profile.role === 'cleaner' && !profile.hourly_rate) {
            await supabase.from('profiles').update({ hourly_rate: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "דמי נסיעות? (0 אם כלול)" });
        }
        else if (profile.role === 'cleaner' && profile.travel_fee === null) {
            await supabase.from('profiles').update({ travel_fee: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ספר/י על עצמך במשפט אחד:" });
        }
        else if (profile.role === 'cleaner' && !profile.bio) {
            await supabase.from('profiles').update({ bio: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל מוכן! ✨" });
        }

        // 4. לוגיקת הקישור (Matching Logic)
        else {
            // א. לקוח מבקש מנקה
            if (profile.role === 'client' && (incomingMsg.includes('ניקיון') || incomingMsg.includes('תיאום'))) {
                await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'pending' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `🔎 מחפש מנקה ב${profile.city}...` });

                const { data: cleaners } = await supabase.from('profiles').select('phone_number').eq('role', 'cleaner').eq('city', profile.city);
                if (cleaners) {
                    cleaners.forEach(c => sendTemplate(c.phone_number, 'HXd2f1d5fe4e58f73b4edb85b2450fc1dc', { "1": profile.city }));
                }
            }
            // ב. מנקה מאשרת עבודה (התיקון כאן!)
            else if (profile.role === 'cleaner' && (incomingMsg === 'job_accept' || incomingMsg.includes('פנוי'))) {
                const { data: job } = await supabase.from('jobs').select('*').eq('city', profile.city).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).single();
                if (job) {
                    await supabase.from('jobs').update({ cleaner_phone: from, status: 'confirmed' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `העבודה שלך! 📞 לקוח: ${job.client_phone}` });
                    
                    const card = `⭐ נמצאה מנקה! ⭐\n\nשם: ${profile.full_name}\nמחיר: ${profile.hourly_rate}₪ + ${profile.travel_fee}₪ נסיעות\n\nתיאור: ${profile.bio}`;
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: job.client_phone, body: card });
                } else {
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מישהו כבר הקדים אותך לעבודה הזו. נעדכן בפעם הבאה! 🧹" });
                }
            }
            // ג. מנקה מסמנת סיום
            else if (profile.role === 'cleaner' && (incomingMsg.includes('סיימתי') || incomingMsg.includes('סיום'))) {
                const { data: job } = await supabase.from('jobs').select('*').eq('cleaner_phone', from).eq('status', 'confirmed').single();
                if (job) {
                    await supabase.from('jobs').update({ status: 'completed' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: job.client_phone, body: "הניקיון הסתיים! ✨ איך היה? דרג/י 1-5:" });
                }
            }
            // ד. לקוח מדרג
            else if (profile.role === 'client' && !isNaN(incomingMsg) && incomingMsg >= 1 && incomingMsg <= 5) {
                const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'completed').order('created_at', { ascending: false }).limit(1).single();
                if (job) {
                    await supabase.from('reviews').insert([{ job_id: job.id, cleaner_phone: job.cleaner_phone, client_phone: from, rating: parseInt(incomingMsg) }]);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "תודה! עכשיו כתוב/י בכמה משפטים מה חשבת על המנקה:" });
                }
            }
            // ה. תפריט ברירת מחדל
            else {
                if (profile.role === 'client') await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
                else await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ממתינים לעבודות... 🧹" });
            }
        }
    } catch (err) { console.error(err); }
    res.status(200).send('OK');
});

app.listen(process.env.PORT || 3000);
