const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;
    const twiml = new MessagingResponse();

    console.log(`Received message from ${from}: ${incomingMsg}`); // לוג לצפייה ב-Render

    try {
        let { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('phone_number', from)
            .single();

        // 1. משתמש חדש - שלב בחירת תפקיד
        if (!profile) {
            if (incomingMsg.includes('לקוח') || incomingMsg.includes('מנקה')) {
                const role = incomingMsg.includes('לקוח') ? 'client' : 'cleaner';
                const { error: insertError } = await supabase
                    .from('profiles')
                    .insert([{ phone_number: from, role: role }]);
                
                if (insertError) throw insertError;
                twiml.message("נרשמת בהצלחה! 🎉\nעכשיו, איך קוראים לך? (שלח/י שם מלא)");
            } else {
                twiml.message("ברוכים הבאים ל-CleanMatch! 🧹\nכדי להתחיל, כתוב/י האם את/ה *לקוח* או *מנקה*?");
            }
        } 
        // 2. שלב איסוף השם
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            twiml.message(`נעים מאוד ${incomingMsg}! 😊\nבאיזו עיר את/ה גר/ה?`);
        }
        // 3. שלב איסוף העיר
        else if (!profile.city) {
            await supabase.from('profiles').update({ city: incomingMsg }).eq('phone_number', from);
            twiml.message("תודה! הרישום הסתיים. ✅\nבקרוב תוכל/י להתחיל להשתמש בשירות.");
        }
        // 4. משתמש רשום
        else {
            twiml.message(`שלום ${profile.full_name}, איזה כיף לראות אותך! במה אוכל לעזור היום?`);
        }
    } catch (err) {
        console.error("Database Error:", err);
        twiml.message("אופס, משהו השתבש. נסה שוב בעוד דקה.");
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
