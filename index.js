const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// הגדרות חיבור
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// פונקציית עזר לשליחת תבנית (כפתורים)
async function sendTemplate(to, contentSid) {
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886', // וודא שזה מספר הסנדבוקס שלך
            to: to,
            contentSid: contentSid
        });
    } catch (error) {
        console.error('Error sending template:', error);
    }
}

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;

    try {
        let { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('phone_number', from)
            .single();

        // 1. משתמש חדש - שליחת כפתורי בחירת תפקיד
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                const role = incomingMsg === 'לקוח' ? 'client' : 'cleaner';
                await supabase.from('profiles').insert([{ phone_number: from, role: role }]);
                // שליחת הודעת טקסט רגילה לבקשת שם
                await client.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: from,
                    body: "נרשמת בהצלחה! 🎉 עכשיו, איך קוראים לך? (שלח/י שם מלא)"
                });
            } else {
                // שליחת כפתורי בחירת תפקיד (ה-HX שנתת לי)
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc');
            }
        } 
        // 2. שלב איסוף השם
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            await client.messages.create({
                from: 'whatsapp:+14155238886',
                to: from,
                body: `נעים מאוד ${incomingMsg}! 😊 באיזו עיר את/ה גר/ה?`
            });
        }
        // 3. שלב איסוף העיר
        else if (!profile.city) {
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            const msg = profile.role === 'client' ? "הרישום הסתיים! ✅" : "הרישום הסתיים! ✅ אנו נעדכן אותך על עבודות חדשות.";
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: msg });
            
            // אם הוא לקוח, שלח לו מיד את תפריט הכפתורים הראשי
            if (profile.role === 'client') {
                await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
            }
        }
        // 4. לוגיקה למשתמש רשום - תיקון הבאג
        else {
            if (profile.role === 'client') {
                if (incomingMsg.includes('ניקיון')) {
                    await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'pending' }]);
                    await client.messages.create({
                        from: 'whatsapp:+14155238886',
                        to: from,
                        body: `🔎 מחפש מנקה ב${profile.city}... אעדכן אותך ברגע שמישהו יאשר.`
                    });
                } else {
                    // שליחת תפריט כפתורים ראשי ללקוח (ה-HX השני)
                    await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
                }
            } else {
                // מנקה - הודעה כללית
                await client.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: from,
                    body: `שלום ${profile.full_name}, כרגע אין עבודות חדשות ב${profile.city}. נעדכן אותך כאן! 🧹`
                });
            }
        }
    } catch (err) {
        console.error(err);
    }

    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanMatch Buttons Server running on port ${PORT}`));
