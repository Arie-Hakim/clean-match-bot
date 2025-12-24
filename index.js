const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// חיבור ל-Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;
    const twiml = new MessagingResponse();

    console.log(`Message from ${from}: ${incomingMsg}`);

    try {
        // 1. חיפוש המשתמש בטבלת profiles
        let { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('phone_number', from)
            .single();

        // 2. טיפול במשתמש חדש (בחירת תפקיד)
        if (!profile) {
            if (incomingMsg.includes('לקוח') || incomingMsg.includes('מנקה')) {
                const role = incomingMsg.includes('לקוח') ? 'client' : 'cleaner';
                await supabase.from('profiles').insert([{ phone_number: from, role: role }]);
                twiml.message("נרשמת בהצלחה! 🎉\nעכשיו, איך קוראים לך? (שלח/י שם מלא)");
            } else {
                twiml.message("ברוכים הבאים ל-CleanMatch! 🧹\nכדי להתחיל, כתוב/י האם את/ה *לקוח* או *מנקה*?");
            }
        } 
        // 3. שלב איסוף השם
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            twiml.message(`נעים מאוד ${incomingMsg}! 😊\nבאיזו עיר את/ה גר/ה?`);
        }
        // 4. שלב איסוף העיר
        else if (!profile.city) {
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            twiml.message("תודה! הרישום הסתיים. ✅\nמה תרצה/י לעשות היום?\n\nכתוב/י *'ניקיון'* כדי למצוא עזרה.");
        }
        // 5. לוגיקה למשתמש רשום - יצירת עבודה חדשה
        else {
            if (incomingMsg.includes('ניקיון')) {
                // יצירת שורה חדשה בטבלת jobs
                const { error: jobError } = await supabase
                    .from('jobs')
                    .insert([{ 
                        client_phone: from, 
                        city: profile.city, 
                        status: 'pending' 
                    }]);

                if (jobError) throw jobError;

                twiml.message(`קיבלתי! מחפש לך מנקה באזור ${profile.city}... 🔎\nאעדכן אותך ברגע שמישהו יתפנה.`);
            } 
            else if (incomingMsg.includes('סטטוס')) {
                twiml.message("כרגע אין לנו עדכון על הזמנה פעילה. ברגע שיימצא מנקה, תקבל/י הודעה.");
            }
            else {
                twiml.message(`שלום ${profile.full_name}, מה תרצה/י לעשות?\n\n1. כתוב/י *'ניקיון'* - למציאת מנקה.\n2. כתוב/י *'סטטוס'* - לבדיקת הזמנות.`);
            }
        }
    } catch (err) {
        console.error("Error details:", err);
        twiml.message("אופס, חלה שגיאה במערכת. נסה שוב מאוחר יותר.");
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// הגדרת הפורט עבור Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`CleanMatch server is running on port ${PORT}`);
});
