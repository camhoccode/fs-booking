--[[
  Confirm Seats Script
  Converts held seats to permanently booked status after payment success
  Only confirms seats that belong to the specified booking

  KEYS[1]: showtime:{showtimeId}:seats (Hash containing seat status)

  ARGV[1]: booking_id
  ARGV[2..n]: seat_ids to confirm

  Returns JSON:
    {success: true, confirmed: N, failed: [...]} - Confirmation result
]]

local seats_key = KEYS[1]
local booking_id = ARGV[1]

-- Validate input
if not booking_id or booking_id == '' then
  return cjson.encode({success = false, message = 'INVALID_INPUT', error = 'booking_id is required'})
end

local seat_count = #ARGV - 1
if seat_count <= 0 then
  return cjson.encode({success = false, message = 'INVALID_INPUT', error = 'at least one seat_id is required'})
end

-- Get current timestamp
local now = tonumber(redis.call('TIME')[1])

local confirmed = 0
local failed = {}

for i = 2, #ARGV do
  local seat_id = ARGV[i]
  local current_status = redis.call('HGET', seats_key, seat_id)

  if not current_status then
    table.insert(failed, {id = seat_id, reason = 'NOT_FOUND'})
  else
    local status_data = cjson.decode(current_status)

    -- Only confirm if:
    -- 1. Seat is held (not already booked)
    -- 2. Booking ID matches
    if status_data.status ~= 'held' then
      table.insert(failed, {id = seat_id, reason = 'NOT_HELD', current_status = status_data.status})
    elseif status_data.booking_id ~= booking_id then
      table.insert(failed, {id = seat_id, reason = 'WRONG_BOOKING', held_by = status_data.booking_id})
    else
      -- Check if hold has expired
      local held_until = tonumber(status_data.held_until) or 0
      if held_until < now then
        table.insert(failed, {id = seat_id, reason = 'HOLD_EXPIRED'})
      else
        -- Confirm the seat
        status_data.status = 'booked'
        status_data.held_until = nil
        status_data.confirmed_at = now

        redis.call('HSET', seats_key, seat_id, cjson.encode(status_data))
        confirmed = confirmed + 1
      end
    end
  end
end

return cjson.encode({
  success = (#failed == 0),
  message = (#failed == 0) and 'SUCCESS' or 'PARTIAL_SUCCESS',
  confirmed = confirmed,
  failed = failed,
  booking_id = booking_id
})
