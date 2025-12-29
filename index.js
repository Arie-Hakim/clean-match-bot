const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- פונקציות עזר ---

async function sendTemplate(to, contentSid, variables = {}) {
    console.log(`[Twilio Log] שולח תבנית ${contentSid} ל-${to}. משתנים:`, variables);
    try {
        await client.messages.create({
            from: 'whatsapp:+14155238886',
            to: to,
            contentSid: contentSid,
            contentVariables: JSON.stringify(variables)
        });
    } catch (e) { console.error(`[Twilio Error] שגיאה בשליחה ל-${to}:`, e.message); }
}

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : "";
    const from = req.body.From;

    console.log(`\n--- הודעה חדשה: ${from} | תוכן: "${incomingMsg}" ---`);

    try {
        let { data: profile } = await supabase.from('profiles').select('*').eq('phone_number', from).single();

        // 1. חשיפת פרטים הדדית לאחר אישור לקוחה
        if (profile?.role === 'client' && incomingMsg === 'approve_match') {
            console.log(`[Flow] אישור התאמה ע"י לקוחה ${from}`);
            const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'pending_approval').order('created_at', { ascending: false }).limit(1).single();
            
            if (job) {
                await supabase.from('jobs').update({ status: 'confirmed' }).eq('id', job.id);
                const { data: cleaner } = await supabase.from('profiles').select('*').eq('phone_number', job.cleaner_phone).single();
                
                const cleanerPhone = cleaner.phone_number.replace('whatsapp:', '');
                const clientPhone = from.replace('whatsapp:', '');

                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `סגרנו! 🎉 הטלפון של ${cleaner.full_name} הוא: ${cleanerPhone}` });
                await client.messages.create({ from: 'whatsapp:+14155238886', to: job.cleaner_phone, body: `הלקוחה אישרה! 🎉 הטלפון של ${profile.full_name} הוא: ${clientPhone}\nצרי קשר לתיאום. כתבי "סיימתי" בסיום העבודה.` });
                return res.status(200).send('OK');
            }
        }

        // 2. רישום: שם, תפקיד וערים (תמיכה בריבוי ערים למנקה)
        if (!profile) {
            if (incomingMsg === 'לקוח' || incomingMsg === 'מנקה') {
                await supabase.from('profiles').insert([{ phone_number: from, role: incomingMsg === 'לקוח' ? 'client' : 'cleaner' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "נעים מאוד! איך קוראים לך? (שם מלא)" });
            } else { await sendTemplate(from, 'HXcde09f46bc023aa95fd7bb0a705fa2dc'); }
        } 
        else if (!profile.full_name) {
            await supabase.from('profiles').update({ full_name: incomingMsg }).eq('phone_number', from);
            profile.role === 'client' ? await sendTemplate(from, 'HX232d288f7201dcedae6c483b80692b9d') : await sendTemplate(from, 'HXd9def526bc4c9013994cfe6a3b0d4898');
        }
        else if (profile.role === 'cleaner' && incomingMsg === 'yes_another_city') {
            console.log(`[Reg] מנקה ${from} מבקש להוסיף עיר נוספת.`);
            await sendTemplate(from, 'HXd9def526bc4c9013994cfe6a3b0d4898');
        }
        else if (!profile.city || (profile.role === 'cleaner' && !profile.hourly_rate && incomingMsg !== 'no_more_cities')) {
            const isCity = ["פתח תקווה", "תל אביב", "ראשון לציון", "רמת גן", "חולון", "בני ברק", "גבעתיים", "הרצליה", "רעננה", "הוד השרון", "כפר סבא"].includes(incomingMsg);
            if (isCity) {
                const currentCities = profile.city ? `${profile.city}, ${incomingMsg}` : incomingMsg;
                await supabase.from('profiles').update({ city: currentCities }).eq('phone_number', from);
                profile.role === 'cleaner' ? await sendTemplate(from, 'HX562db4f76686ae94f9827ba35d75a1cd') : await sendTemplate(from, 'HX3ae58035fa14b0f81c94e98093b582fa');
            } else if (incomingMsg === 'no_more_cities') {
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "מה המחיר לשעה שלך בשקלים? (מספר בלבד)" });
            }
        }
        
        // 3. איסוף נתונים מקצועיים למנקה
        else if (profile.role === 'cleaner' && !profile.hourly_rate) {
            await supabase.from('profiles').update({ hourly_rate: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "דמי נסיעות? (0 אם כלול)" });
        }
        else if (profile.role === 'cleaner' && profile.travel_fee === null) {
            await supabase.from('profiles').update({ travel_fee: parseInt(incomingMsg) }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "ספר/י על עצמך במשפט אחד (ניסיון וכו')." });
        }
        else if (profile.role === 'cleaner' && !profile.bio) {
            await supabase.from('profiles').update({ bio: incomingMsg }).eq('phone_number', from);
            await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל מוכן! נעדכן אותך כשתהיה עבודה בעיר שלך. ✨" });
        }

        // 4. לוגיקת שידוך (Matching)
        else {
            if (profile.role === 'client' && (incomingMsg.includes('ניקיון') || incomingMsg.includes('תיאום'))) {
                console.log(`[Matching] לקוחה ${from} מחפשת ב-${profile.city}`);
                await supabase.from('jobs').insert([{ client_phone: from, city: profile.city, status: 'pending' }]);
                await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: `🔎 מחפש מנקה ב${profile.city}...` });

                const { data: allCleaners } = await supabase.from('profiles').select('*').eq('role', 'cleaner');
                const relevantCleaners = allCleaners.filter(c => c.city && c.city.includes(profile.city));
                console.log(`[Matching] נמצאו ${relevantCleaners.length} מנקות רלוונטיות.`);
                relevantCleaners.forEach(c => sendTemplate(c.phone_number, 'HXd2f1d5fe4e58f73b4edb85b2450fc1dc', { "1": profile.city }));
            }
            else if (profile.role === 'cleaner' && (incomingMsg === 'job_accept' || incomingMsg.includes('פנוי'))) {
                const { data: job } = await supabase.from('jobs').select('*').eq('status', 'pending');
                const matchingJob = job.find(j => profile.city.includes(j.city));
                if (matchingJob) {
                    await supabase.from('jobs').update({ cleaner_phone: from, status: 'pending_approval' }).eq('id', matchingJob.id);
                    await client.messages.create({ from: 'whatsapp:+14155238886', to: from, body: "הפרופיל שלך נשלח ללקוחה. מחכים לאישורה! ⏳" });
                    await sendTemplate(matchingJob.client_phone, 'HX7aa935f1701a55ddf2bce2cce57bd12b', { "1": profile.full_name, "2": profile.hourly_rate.toString(), "3": profile.travel_fee.toString(), "4": profile.bio });
                }
            }
        }
    } catch (err) { console.error(`[CRITICAL ERROR]`, err); }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanMatch 3.5 Running...`));
