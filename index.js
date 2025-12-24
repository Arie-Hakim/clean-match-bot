const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// חיבור ל-Supabase בעזרת משתני הסביבה שהגדרנו ב-Render
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// הפונקציה המרכזית של הבוט
app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : '';
    const from = req.body.From;
    const twiml = new MessagingResponse();

    try {
        // 1. בדיקה האם המשתמש כבר קיים בבסיס הנתונים
        let { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('phone_number', from)
            .single();

        // 2. טיפול במשתמש חדש לגמרי
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                const role = incomingMsg === 'לקוח' ? 'client' : 'cleaner';
                await supabase.from('profiles').insert([{ phone_number: from, role: role }]);
                twiml.message("נרשמת בהצלחה! עכשיו, איך קוראים לך? (שלח/י שם מלא)");
            } else {
                twiml.message("ברוכים הבאים ל-CleanMatch! 🧹\nכדי להתחיל, כתוב/י האם את/ה *לקוח* או *מנקה*?");
            }
        } 
        // 3. משתמש קיים - שלב איסוף השם (אם חסר שם)
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            twiml.message(`נעים מאוד ${incomingMsg}! באיזו עיר את/ה גר/ה?`);
        }
        // 4. משתמש קיים - שלב איסוף העיר (אם חסרה עיר)
        else if (!profile.city) {
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            twiml.message("תודה! הרישום הסתיים. בקרוב תוכל/י להתחיל להשתמש בשירות.");
        }
        // 5. משתמש רשום מלא
        else {
            twiml.message(`שלום ${profile.full_name}, מה תרצה/י לעשות היום?`);
        }
    } catch (err) {
        console.error("Error details:", err);
        twiml.message("אופס, משהו השתבש בשרת. נסה שוב מאוחר יותר.");
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// הגדרת הפורט עבור Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`CleanMatch server is running on port ${PORT}`);
});
