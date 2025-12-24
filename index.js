const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");
const { MessagingResponse } = require("twilio").twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.post("/whatsapp", async (req, res) => {
    const incomingMsg = req.body.Body;
    const from = req.body.From;
    const twiml = new MessagingResponse();

    try {
        let { data: profile, error } = await supabase
            .from("profiles")
            .select("*")
            .eq("phone_number", from)
            .single();

        if (!profile) {
            twiml.message(
                "ברוכים הבאים ל-CleanMatch! 🧹\nלא זיהיתי את המספר שלך.\nהאם תרצה/י להירשם כ*לקוח* או כ*מנקה*?",
            );
        } else {
            twiml.message(
                `שלום ${profile.full_name}, איזה כיף לראות אותך שוב!`,
            );
        }
    } catch (err) {
        console.error(err);
        twiml.message("מצטער, חלה שגיאה במערכת.");
    }

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());
});

// השינוי החשוב עבור Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
