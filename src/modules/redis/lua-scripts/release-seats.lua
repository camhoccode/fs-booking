--[[
  Release Seats Script
  Releases held seats back to available status
  Only releases seats that belong to the specified booking

  KEYS[1]: showtime:{showtimeId}:seats (Hash containing seat status)
  KEYS[2]: showtime:{showtimeId}:available (Atomic counter)

  ARGV[1]: booking_id
  ARGV[2..n]: seat_ids to release

  Returns JSON:
    {success: true, released: N, failed: [...]} - Release result
]]

local seats_key = KEYS[1]
local available_key = KEYS[2]
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

local released = 0
local failed = {}

for i = 2, #ARGV do
  local seat_id = ARGV[i]
  local current_status = redis.call('HGET', seats_key, seat_id)

  if not current_status then
    table.insert(failed, {id = seat_id, reason = 'NOT_FOUND'})
  else
    local status_data = cjson.decode(current_status)

    -- Only release if booking_id matches
    -- Can release both 'held' and 'booked' seats (for refund scenarios)
    if status_data.booking_id ~= booking_id then
      table.insert(failed, {id = seat_id, reason = 'WRONG_BOOKING', held_by = status_data.booking_id or 'none'})
    else
      -- Reset to available status
      local available_data = cjson.encode({
        status = 'available',
        seat_type = status_data.seat_type,
        released_at = now,
        previous_booking = booking_id
      })

      redis.call('HSET', seats_key, seat_id, available_data)
      released = released + 1
    end
  end
end

-- Increment available counter for released seats
if released > 0 then
  redis.call('INCRBY', available_key, released)
end

return cjson.encode({
  success = (#failed == 0),
  message = (#failed == 0) and 'SUCCESS' or 'PARTIAL_SUCCESS',
  released = released,
  failed = failed,
  booking_id = booking_id
})
