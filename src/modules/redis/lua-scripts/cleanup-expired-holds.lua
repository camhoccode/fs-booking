--[[
  Cleanup Expired Holds Script
  Releases all expired held seats back to available status
  Called by cron job to prevent orphaned holds

  KEYS[1]: showtime:{showtimeId}:seats (Hash containing seat status)
  KEYS[2]: showtime:{showtimeId}:available (Atomic counter)

  ARGV: none

  Returns JSON:
    {success: true, released: N, seats: [...]} - Cleanup result
]]

local seats_key = KEYS[1]
local available_key = KEYS[2]

-- Get current timestamp from Redis server
local now = tonumber(redis.call('TIME')[1])

-- Get all seats
local all_seats = redis.call('HGETALL', seats_key)

local released = 0
local released_seats = {}

-- Iterate through seats (key-value pairs)
for i = 1, #all_seats, 2 do
  local seat_id = all_seats[i]
  local seat_data_raw = all_seats[i + 1]

  if seat_data_raw then
    local status_data = cjson.decode(seat_data_raw)

    -- Only process held seats
    if status_data.status == 'held' then
      local held_until = tonumber(status_data.held_until) or 0

      -- Check if hold has expired
      if held_until < now then
        -- Reset to available
        local available_data = cjson.encode({
          status = 'available',
          seat_type = status_data.seat_type,
          released_at = now,
          released_reason = 'HOLD_EXPIRED',
          previous_booking = status_data.booking_id
        })

        redis.call('HSET', seats_key, seat_id, available_data)
        released = released + 1
        table.insert(released_seats, {
          id = seat_id,
          previous_booking = status_data.booking_id,
          expired_at = held_until
        })
      end
    end
  end
end

-- Increment available counter for all released seats
if released > 0 then
  redis.call('INCRBY', available_key, released)
end

return cjson.encode({
  success = true,
  message = 'CLEANUP_COMPLETE',
  released = released,
  seats = released_seats,
  cleanup_time = now
})
