const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- פונקציות עזר ---

// פונקציית נורמליזציה משופרת - מטפלת בווריאציות של כתיב עברי
function normalizeCity(city) {
    if (!city) return "";
    let clean = city.trim()
        .replace(/יי/g, 'י')
        .replace(/וו/g, 'ו')
        .replace(/-/g, ' ') // הופך תל-אביב לתל אביב
        .replace(/"/g, '')
        .replace(/'/g, '')
        .replace(/\s+/g, ' '); // ניקוי רווחים כפולים
    console.log(`[City Normalizer] Original: "${city}" -> Normalized: "${clean}"`);
    return clean;
}

async function sendTemplate(to, contentSid, variables = {}) {
    console.log(`[Twilio] Sending Template ${contentSid} to ${to} with variables:`, variables);
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886',
            to: to,
            contentSid: contentSid,
            contentVariables: JSON.stringify(variables)
        });
        console.log(`[Twilio] Message sent successfully to ${to}`);
    } catch (error) {
        console.error(`[Twilio Error] Failed to send template to ${to}:`, error.message);
    }
}

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;

    console.log(`\n--- New Message Received ---`);
    console.log(`From: ${from}`);
    console.log(`Message: "${incomingMsg}"`);

    try {
        let { data: profile, error: profileError } = await supabase.from('profiles').select('*').eq('phone_number', from).single();
        
        if (profile) console.log(`[Profile] Found: Name: ${profile.full_name}, Role: ${profile.role}, City: ${profile.city}`);
        else console.log(`[Profile] Not found for ${from}`);

        // 1. שלב אישור לקוחה (approve_match)
        if (profile?.role === 'client' && incomingMsg === 'approve_match') {
            console.log(`[Logic] Client ${from} approved a match.`);
            const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'pending_approval').order('created_at', { ascending: false }).limit(1).single();
            
            if (job) {
                console.log(`[Logic] Found job ID: ${job.id} awaiting approval.`);
                await supabase.from('jobs').update({ status: 'confirmed' }).eq('id', job.id);
                const { data: cleaner } = await supabase.from('profiles').select('*').eq('phone_number', job.cleaner_phone).single();
                
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `מעולה! התיאום נסגר. 📞 הטלפון של ${cleaner.full_name} הוא: ${cleaner.phone_number}` });
                await client.messages.create({ from: 'whatsapp:+14155238886', to: cleaner.phone_number, body: `הלקוחה אישרה! 🎉 הטלפון של ${profile.full_name} הוא: ${from}\nכתבי "סיימתי" בסיום העבודה.` });
                return res.status(200).send('OK');
            } else {
                console.log(`[Logic] No pending_approval job found for client ${from}`);
            }
        }

        // 2. רישום ראשוני
        if (!profile) {
            console.log(`[Logic] Starting registration flow for ${from}`);
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                const role = incomingMsg === 'לקוח' ? 'client' : 'cleaner';
                await supabase.from('profiles').insert([{ phone_number: from, role: role }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ברוך הבא! 🎉 איך קוראים לך? (שם מלא)" });
            } else {
                await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc');
            }
        } 
        // 3. המשך איסוף פרטים
        else if (!profile.full_name) {
            console.log(`[Logic] Saving name for ${from}: ${incomingMsg}`);
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "באיזו עיר את/ה גר/ה?" });
        }
        else if (!profile.city) {
            const cleanCity = normalizeCity(incomingMsg);
            console.log(`[Logic] Saving city for ${from}: ${cleanCity}`);
            await supabase.from('profiles').update({ city: cleanCity }).eq('phone_number', from);
            if (profile.role === 'client') {
                await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
            } else {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מה המחיר לשעה שלך? (מספר בלבד)" });
            }
        }
        // ... (שאר שלבי איסוף הנתונים למנקה - מחיר, נסיעות וביו)
        
        // 4. לוגיקת שידוך (Broadcasting)
        else {
            if (profile.role === 'client' && (incomingMsg.includes('ניקיון') || incomingMsg.includes('תיאום'))) {
                console.log(`[Matching] Client ${from} in city ${profile.city} requested a cleaner.`);
                
                const { data: job, error: jobError } = await supabase.from('jobs').insert([{ 
                    client_phone: from, 
                    city: profile.city, 
                    status: 'pending' 
                }]).select().single();

                if (jobError) console.error(`[DB Error] Job creation failed:`, jobError);
                else console.log(`[DB] Job created with ID: ${job.id}`);

                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `🔎 מחפש מנקה ב${profile.city}...` });

                // חיפוש מנקות בעיר
                const { data: cleaners, error: cleanersError } = await supabase.from('profiles')
                    .select('phone_number, city')
                    .eq('role', 'cleaner')
                    .eq('city', profile.city);

                console.log(`[Matching] Search results for city "${profile.city}": Found ${cleaners ? cleaners.length : 0} cleaners.`);

                if (cleaners && cleaners.length > 0) {
                    cleaners.forEach(c => {
                        console.log(`[Matching] Broadcasting to cleaner: ${c.phone_number}`);
                        sendTemplate(c.phone_number, 'HXd2f1d5fe4e58f73b4edb85b2450fc1dc', { "1": profile.city });
                    });
                } else {
                    console.log(`[Matching] No cleaners found in city: ${profile.city}`);
                }
            }
            // מנקה מאשרת שהיא פנויה
            else if (profile.role === 'cleaner' && (incomingMsg === 'job_accept' || incomingMsg.includes('פנוי'))) {
                console.log(`[Matching] Cleaner ${from} responded "Available".`);
                const { data: job } = await supabase.from('jobs').select('*').eq('city', profile.city).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).single();
                
                if (job) {
                    console.log(`[Matching] Found pending job ID: ${job.id}. Notifying client ${job.client_phone}`);
                    await supabase.from('jobs').update({ cleaner_phone: from, status: 'pending_approval' }).eq('id', job.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הצגת הפרופיל שלך נשלחה ללקוחה. מחכים לאישור שלה! ⏳" });
                    
                    await sendTemplate(job.client_phone, 'HX7aa935f1701a55ddf2bce2cce57bd12b', {
                        "1": profile.full_name,
                        "2": (profile.hourly_rate || 0).toString(),
                        "3": (profile.travel_fee || 0).toString(),
                        "4": profile.bio || ""
                    });
                } else {
                    console.log(`[Matching] No pending job found in ${profile.city} for cleaner ${from}`);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מצטערים, העבודה כבר נתפסה. נעדכן בפעם הבאה!" });
                }
            }
        }
    } catch (err) { 
        console.error(`[Critical Error]`, err); 
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] CleanMatch 2.7 with Logs running on port ${PORT}`));
