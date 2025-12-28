const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// פונקציית עזר לשליחת תבניות עם משתנים (Variables)
async function sendTemplate(to, contentSid, variables = {}) {
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886',
            to: to,
            contentSid: contentSid,
            contentVariables: JSON.stringify(variables) // כאן נכנסים המשתנים כמו {{1}}
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

        // --- 1. רישום משתמש (השארתי את הלוגיקה הקודמת שלך) ---
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "נרשמת! איך קוראים לך?" });
            } else {
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc');
            }
        } 
        else if (!profile.full_name || !profile.city || (profile.role === 'cleaner' && !profile.bio)) {
            // ... (כאן נכנסת לוגיקת איסוף השם/עיר/ביו שכתבנו קודם)
            // לצורך הקיצור, נניח שהמשתמש כבר רשום במלואו
        }

        // --- 2. לוגיקת "שידוך" (The Matching Engine) ---
        else {
            // א. לקוח מבקש ניקיון
            if (profile.role === 'client' && incomingMsg.includes('ניקיון')) {
                // יצירת הג'וב ב-Supabase
                const { data: job } = await supabase.from('jobs').insert([{ 
                    client_phone: from, 
                    city: profile.city, 
                    status: 'pending' 
                }]).select().single();

                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `🔎 מחפש מנקה ב${profile.city}... אעדכן אותך מיד!` });

                // **Broadcasting**: שליחה לכל המנקות בעיר
                const { data: cleaners } = await supabase
                    .from('profiles')
                    .select('phone_number')
                    .eq('role', 'cleaner')
                    .eq('city', profile.city);

                if (cleaners) {
                    cleaners.forEach(cleaner => {
                        // שליחת תבנית cleaner_job_offer עם שם העיר
                        sendTemplate(cleaner.phone_number, 'HXd2f1d5fe4e58f73b4edb85b2450fc1dc', { "1": profile.city });
                    });
                }
            }
            
            // ב. מנקה מאשרת עבודה (קבלת הערך מהכפתור)
            else if (profile.role === 'cleaner' && incomingMsg === 'job_accept') {
                // מציאת העבודה האחרונה שמחכה בעיר של המנקה
                const { data: pendingJob } = await supabase
                    .from('jobs')
                    .select('*')
                    .eq('city', profile.city)
                    .eq('status', 'pending')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single();

                if (pendingJob) {
                    // עדכון העבודה - היא כבר לא מחכה
                    await supabase.from('jobs').update({ cleaner_phone: from, status: 'confirmed' }).eq('id', pendingJob.id);

                    // שליחת הודעה למנקה
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מעולה! העבודה שלך. הנה פרטי הלקוח: " + pendingJob.client_phone });

                    // שליחת "כרטיסיית מנקה" ללקוח (הויז'ן שלך!)
                    const cleanerCard = `⭐ נמצאה מנקה! ⭐\n\nשם: ${profile.full_name}\nמחיר: ${profile.hourly_rate} ₪/שעה\nנסיעות: ${profile.travel_fee} ₪\n\nקצת עליה: ${profile.bio}\n\nהיא תיצור איתך קשר בדקות הקרובות.`;
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: pendingJob.client_phone, body: cleanerCard });
                } else {
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "אופס, מישהו אחר כבר לקח את העבודה הזו. נעדכן אותך בפעם הבאה!" });
                }
            }
            
            // ג. תפריט ברירת מחדל
            else {
                if (profile.role === 'client') await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
                else await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ממתינים לעבודות חדשות עבורך... 🧹" });
            }
        }
    } catch (err) { console.error(err); }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Broadcasting Engine Live`));
