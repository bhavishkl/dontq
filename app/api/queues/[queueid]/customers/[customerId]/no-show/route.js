import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function archiveQueueEntry(queueId, entryId) {
  try {
    // Fetch the queue entry to be archived
    const { data: entryData, error: fetchError } = await supabase
      .from('queue_entries')
      .select('*')
      .match({ queue_id: queueId, entry_id: entryId })
      .single();

    if (fetchError) {
      console.error('Error fetching queue entry:', fetchError);
      return false;
    }

    if (!entryData) {
      console.error('No queue entry found to archive');
      return false;
    }

    // Calculate actual wait time
    const actualWaitTime = Math.floor((new Date() - new Date(entryData.join_time)) / 60000);

    // Insert into queue_entries_archive
    const { error: insertError } = await supabase
      .from('queue_entries_archive')
      .insert({
        queue_id: entryData.queue_id,
        user_id: entryData.user_id,
        status: 'no-show',
        wait_time: entryData.estimated_wait_time,
        actual_wait_time: actualWaitTime,
        join_time: entryData.join_time,
        leave_time: new Date().toISOString(),
      });

    if (insertError) {
      console.error('Error inserting into archive:', insertError);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Unexpected error in archiving queue entry:', error);
    return false;
  }
}

export async function POST(request, { params }) {
  const { queueid: queueId, customerId } = params;

  if (!queueId || !customerId) {
    console.log('Invalid queue ID or customer ID');
    return NextResponse.json({ error: 'Invalid queue ID or customer ID' }, { status: 400 });
  }

  try {
    // Archive the queue entry before deleting
    const archiveSuccess = await archiveQueueEntry(queueId, customerId);
    if (!archiveSuccess) {
      console.warn('Failed to archive queue entry, but proceeding with no-show operation');
    }

    // Delete the customer from the queue
    const { error: deleteError } = await supabase
      .from('queue_entries')
      .delete()
      .eq('queue_id', queueId)
      .eq('entry_id', customerId);

    if (deleteError) throw deleteError;

    // Update the queue's current count, total served, and total estimated time
    const { data: queueData, error: queueError } = await supabase
      .from('queues')
      .select('current_queue, total_served, est_time_to_serve')
      .eq('queue_id', queueId)
      .single();

    if (queueError) throw queueError;

    const newQueueCount = Math.max(0, queueData.current_queue - 1);
    const newTotalEstimatedTime = newQueueCount * queueData.est_time_to_serve;

    const { data: updatedQueue, error: updateError } = await supabase
      .from('queues')
      .update({ 
        current_queue: newQueueCount,
        total_estimated_time: newTotalEstimatedTime
      })
      .eq('queue_id', queueId)
      .select('current_queue, total_served, total_estimated_time')
      .single();

    if (updateError) throw updateError;

    // Fetch remaining queue entries
    const { data: queueEntries, error: entriesError } = await supabase
      .from('queue_entries')
      .select('*')
      .eq('queue_id', queueId)
      .order('join_time', { ascending: true });

    if (entriesError) throw entriesError;

    // Check if there's a 5th person in the queue
    if (queueEntries.length >= 5) {
      const fifthPerson = queueEntries[4];
      await notifyCustomer(fifthPerson.user_id);
    }

    return NextResponse.json({ 
      message: 'Customer marked as no-show and removed from queue',
      current_queue: updatedQueue.current_queue,
      total_served: updatedQueue.total_served,
      total_estimated_time: updatedQueue.total_estimated_time
    });
  } catch (error) {
    console.error('Error marking customer as no-show:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function notifyCustomer(userId) {
  try {
    const { data: userData, error: userError } = await supabase
      .from('user_profile')
      .select('phone_number')
      .eq('user_id', userId)
      .single();

    if (userError) throw userError;

    if (userData && userData.phone_number) {
      await sendWhatsAppNotification(userData.phone_number);
    }
  } catch (error) {
    console.error('Error notifying customer:', error);
  }
}

async function sendWhatsAppNotification(phoneNumber) {
  try {
    const options = {
      method: 'POST',
      headers: {
        clientId: process.env.OTPLESS_CLIENT_ID,
        clientSecret: process.env.OTPLESS_CLIENT_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sendTo: phoneNumber,
        channel: "WHATSAPP",
        message: "Your position in the queue is now 5. Please be prepared!"
      })
    };

    const response = await fetch('https://marketing.otpless.app/v1/api/send', options);
    const data = await response.json();

    if (!data.success) {
      throw new Error('Failed to send WhatsApp notification');
    }
  } catch (error) {
    console.error('Error sending WhatsApp notification:', error);
  }
}