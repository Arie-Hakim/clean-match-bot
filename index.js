const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// פונקציית עזר לשליחת תבניות
async function sendTemplate(to, contentSid) {
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886',
            to: to,
            contentSid: contentSid
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

        // 1. רישום ראשוני - בחירת תפקיד
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ברוך הבא! 🎉 איך קוראים לך? (שם מלא)" });
            } else {
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc');
            }
        } 
        // 2. איסוף שם
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `נעים מאוד ${incomingMsg}! באיזו עיר את/ה גר/ה?` });
        }
        // 3. איסוף עיר
        else if (!profile.city) {
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            if (profile.role === 'client') {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הרישום הסתיים! ✅ מה תרצה לעשות?" });
                await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
            } else {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מעולה. עכשיו כמה שאלות מקצועיות: מה המחיר לשעה שלך בשקלים? (שלח מספר בלבד)" });
            }
        }
        // 4. לוגיקה ייחודית למנקה (מחיר, נסיעות, תיאור)
        else if (profile.role === 'cleaner' && !profile.hourly_rate) {
            await supabase.from('profiles').update({ hourly_rate: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "כמה דמי נסיעות את/ה גובה? (שלח 0 אם זה כלול במחיר)" });
        }
        else if (profile.role === 'cleaner' && profile.travel_fee === null) {
            await supabase.from('profiles').update({ travel_fee: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ספר/י על עצמך בכמה משפטים (ניסיון, ציוד וכו'). זה מה שהלקוחות יראו!" });
        }
        else if (profile.role === 'cleaner' && !profile.bio) {
            await supabase.from('profiles').update({ bio: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל שלך מוכן! 🌟 נשלח לך הודעה ברגע שתהיה בקשה לניקיון באזורך." });
        }
        // 5. לוגיקה למשתמשים רשומים מלאים
        else {
            if (profile.role === 'client') {
                if (incomingMsg.includes('ניקיון')) {
                    await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'pending' }]);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `מחפש מנקה ב${profile.city}... אעדכן אותך מיד! 🔎` });
                } else {
                    await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
                }
            } else {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `שלום ${profile.full_name}, אנחנו מחפשים עבורך עבודות ב${profile.city}. נעדכן בקרוב! 🧹` });
            }
        }
    } catch (err) { console.error(err); }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanMatch Vision 2.1 Running`));
