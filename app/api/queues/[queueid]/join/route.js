import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../../auth/[...nextauth]/route";
import twilio from 'twilio';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

export async function POST(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { queueid } = params;

    // Get the current queue information
    const { data: queueData, error: queueError } = await supabase
      .from('queues')
      .select('current_queue, max_capacity, avg_wait_time, est_time_to_serve, name, location')
      .eq('queue_id', queueid)
      .single();

    if (queueError) {
      console.error('Error fetching queue data:', queueError);
      return NextResponse.json({ error: queueError.message }, { status: 500 });
    }

    if (queueData.current_queue >= queueData.max_capacity) {
      return NextResponse.json({ error: 'Queue is full' }, { status: 400 });
    }

    // Get the current queue entries
    const { data: queueEntries, error: queueEntriesError } = await supabase
      .from('queue_entries')
      .select('user_id')
      .eq('queue_id', queueid);

    if (queueEntriesError) {
      console.error('Error fetching queue entries:', queueEntriesError);
      return NextResponse.json({ error: queueEntriesError.message }, { status: 500 });
    }

    const newPosition = queueEntries.length + 1;

    // Add the user to the queue
    const { data: queueEntry, error: insertError } = await supabase
      .from('queue_entries')
      .insert({
        queue_id: queueid,
        user_id: session.user.id,
        position: newPosition,
        status: 'waiting',
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error inserting queue entry:', insertError);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // Update the current queue count and total estimated time
    const newQueueCount = queueData.current_queue + 1;
    const newTotalEstimatedTime = newQueueCount * queueData.est_time_to_serve;

    const { data: updatedQueue, error: updateError } = await supabase
      .from('queues')
      .update({ 
        current_queue: newQueueCount,
        total_estimated_time: newTotalEstimatedTime
      })
      .eq('queue_id', queueid)
      .select('current_queue, total_estimated_time')
      .single();

    if (updateError) {
      console.error('Error updating queue:', updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Fetch user's phone number from user_profile
    const { data: userData, error: userError } = await supabase
      .from('user_profile')
      .select('phone_number')
      .eq('user_id', session.user.id)
      .single();

    if (userError) {
      console.error('Error fetching user phone number:', userError);
    } else if (userData && userData.phone_number) {
      // Send WhatsApp notification
      try {
        // Fetch user name from user_profile
        const { data: userProfileData, error: userProfileError } = await supabase
          .from('user_profile')
          .select('name')
          .eq('user_id', session.user.id)
          .single();

        let userName = 'Valued Customer';
        if (userProfileError) {
          console.error('Error fetching user name:', userProfileError);
        } else if (userProfileData && userProfileData.name) {
          userName = userProfileData.name || 'Valued Customer';
        }

        const estimatedWaitTime = newPosition * queueData.est_time_to_serve;

        const message = `
🌟 Welcome to the Queue, ${userName}! 🌟

You've successfully joined:
🏷️ *${queueData.name}*

Your Details:
🧑‍🤝‍🧑 Position: *${newPosition}*
⏱️ Estimated Wait Time: *${estimatedWaitTime} minutes*
📍 Location: ${queueData.location || 'To be announced'}

📱 Stay close by! We'll keep you updated as your turn approaches.

*🔔 Important:*
*Would you like to be notified when you reach the 7th position in the queue?*
*Reply with 'YES' if you'd like this notification.*

Need assistance?
📧 support@queuesmart.com

Thank you for choosing QueueSmart!
We appreciate your patience and look forward to serving you soon. 🙏
        `.trim();

        await client.messages.create({
          body: message,
          from: 'whatsapp:+14155238886',
          to: `whatsapp:+${userData.phone_number}`
        });
      } catch (error) {
        console.error('Error sending WhatsApp notification:', error);
      }
    } else {
      console.warn('User phone number not found');
    }

    return NextResponse.json({
      message: 'Successfully joined the queue',
      queueEntry: queueEntry,
      updatedQueue: updatedQueue,
      userPosition: newPosition,
      estWaitTime: newPosition * queueData.est_time_to_serve
    });
  } catch (error) {
    console.error('Error joining queue:', error);
    return NextResponse.json({ error: 'An unexpected error occurred', details: error.message }, { status: 500 });
  }
}