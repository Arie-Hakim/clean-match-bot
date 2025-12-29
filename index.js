const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// חיבורים ל-Supabase ו-Twilio (וודא שהמשתנים מוגדרים ב-Render Environment)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// פונקציית עזר לשליחת תבניות עם משתנים
async function sendTemplate(to, contentSid, variables = {}) {
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886', // מספר הסנדבוקס שלך
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

        // 1. בדיקת שלב "ביקורת טקסטואלית" (הלקוח משאיר משפטים על המנקה)
        const { data: openReview } = await supabase.from('reviews')
            .select('*')
            .eq('client_phone', from)
            .is('comment', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (profile?.role === 'client' && openReview && isNaN(incomingMsg)) {
            await supabase.from('reviews').update({ comment: incomingMsg }).eq('id', openReview.id);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "תודה רבה! הביקורת שלך נשמרה ותעזור לאחרים. 🙏" });
            return res.status(200).send('OK');
        }

        // 2. רישום משתמש חדש
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ברוך הבא! 🎉 איך קוראים לך? (שם מלא)" });
            } else {
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc'); // תבנית בחירת תפקיד
            }
        } 
        // 3. איסוף פרטי פרופיל (שם, עיר, ופרטי מנקה)
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `נעים מאוד! באיזו עיר את/ה גר/ה?` });
        }
        else if (!profile.city) {
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            if (profile.role === 'client') {
                await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa'); // תפריט לקוח
            } else {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מה המחיר לשעה שלך בשקלים? (מספר בלבד)" });
            }
        }
        else if (profile.role === 'cleaner' && !profile.hourly_rate) {
            await supabase.from('profiles').update({ hourly_rate: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "כמה דמי נסיעות את/ה גובה? (שלח 0 אם כלול במחיר)" });
        }
        else if (profile.role === 'cleaner' && profile.travel_fee === null) {
            await supabase.from('profiles').update({ travel_fee: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ספר/י על עצמך ועל הניסיון שלך במשפט אחד. זה מה שהלקוחות יראו!" });
        }
        else if (profile.role === 'cleaner' && !profile.bio) {
            await supabase.from('profiles').update({ bio: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל מוכן! נשלח לך הודעה כשתהיה עבודה בעיר שלך. ✨" });
        }

        // 4. לוגיקה למשתמשים רשומים מלאים
        else {
            // א. לקוח מבקש ניקיון
            if (profile.role === 'client' && incomingMsg.includes('ניקיון')) {
                await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'pending' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `🔎 מחפש מנקה ב${profile.city}... אעדכן אותך מיד.` });
                
                // שליחת הודעה לכל המנקות בעיר
                const { data: cleaners } = await supabase.from('profiles').select('phone_number').eq('role', 'cleaner').eq('city', profile.city);
                if (cleaners) {
                    cleaners.forEach(c => sendTemplate(c.phone_number, 'HXd2f1d5fe4e58f73b4edb85b2450fc1dc', { "1": profile.city }));
                }
            }
            
            // ב. מנקה מאשרת עבודה
            else if (profile.role === 'cleaner' && incomingMsg === 'job_accept') {
                const { data: job } = await supabase.from('jobs').select('*').eq('city', profile.city).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).single();
                if (job) {
                    await supabase.from('jobs').update({ cleaner_phone: from, status: 'confirmed' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `העבודה שלך! 📞 טלפון לקוח: ${job.client_phone}\nכתוב "סיימתי" בסיום העבודה.` });
                    
                    // שליחת "כרטיסיית מנקה" ללקוח
                    const card = `⭐ נמצאה התאמה! ⭐\n\nשם: ${profile.full_name}\nמחיר: ${profile.hourly_rate} ₪/שעה\nנסיעות: ${profile.travel_fee} ₪\n\nתיאור: ${profile.bio}\n\nהיא בדרך אליך!`;
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: job.client_phone, body: card });
                }
            }

            // ג. מנקה מסמנת סיום עבודה (הפעלת מערכת הדירוג)
            else if (profile.role === 'cleaner' && incomingMsg.includes('סיימתי')) {
                const { data: job } = await supabase.from('jobs').select('*').eq('cleaner_phone', from).eq('status', 'confirmed').single();
                if (job) {
                    await supabase.from('jobs').update({ status: 'completed' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: job.client_phone, body: "הניקיון הסתיים! ✨ איך היה? דרג/י את המנקה מ-1 עד 5 (שלח/י מספר בלבד)." });
                }
            }

            // ד. לקוח משאיר דירוג מספר (1-5)
            else if (profile.role === 'client' && !isNaN(incomingMsg) && incomingMsg >= 1 && incomingMsg <= 5) {
                const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'completed').order('created_at', { ascending: false }).limit(1).single();
                if (job) {
                    await supabase.from('reviews').insert([{ job_id: job.id, cleaner_phone: job.cleaner_phone, client_phone: from, rating: parseInt(incomingMsg) }]);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "תודה! עכשיו נשמח אם תכתוב/י כמה משפטים על המנקה." });
                }
            }
            
            // ה. תפריט ברירת מחדל
            else {
                if (profile.role === 'client') await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
                else await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ממתינים לעבודות חדשות... 🧹" });
            }
        }
    } catch (err) { console.error(err); }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanMatch Engine 2.3 Live`));
