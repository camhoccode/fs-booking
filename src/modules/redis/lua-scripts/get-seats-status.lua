--[[
  Get Seats Status Script
  Retrieves current status of multiple seats efficiently
  Also cleans up expired holds during read

  KEYS[1]: showtime:{showtimeId}:seats (Hash containing seat status)
  KEYS[2]: showtime:{showtimeId}:available (Atomic counter)

  ARGV[1..n]: seat_ids to check (if empty, returns all seats)

  Returns JSON:
    {
      success: true,
      seats: {seat_id: {...status_data}},
      available_count: N,
      total_seats: N,
      expired_cleaned: N
    }
]]

local seats_key = KEYS[1]
local available_key = KEYS[2]

-- Get current timestamp
local now = tonumber(redis.call('TIME')[1])

local seats = {}
local expired_cleaned = 0

-- Determine if we should get specific seats or all seats
local specific_seats = #ARGV > 0

if specific_seats then
  -- Get specific seats
  for i = 1, #ARGV do
    local seat_id = ARGV[i]
    local seat_data_raw = redis.call('HGET', seats_key, seat_id)

    if seat_data_raw then
      local status_data = cjson.decode(seat_data_raw)

      -- Check for expired holds and clean up
      if status_data.status == 'held' then
        local held_until = tonumber(status_data.held_until) or 0
        if held_until < now then
          -- Expired - clean up and return as available
          local available_data = {
            status = 'available',
            seat_type = status_data.seat_type,
            released_at = now,
            released_reason = 'HOLD_EXPIRED'
          }
          redis.call('HSET', seats_key, seat_id, cjson.encode(available_data))
          redis.call('INCR', available_key)
          expired_cleaned = expired_cleaned + 1
          seats[seat_id] = available_data
        else
          -- Still held - include remaining time
          status_data.remaining_seconds = held_until - now
          seats[seat_id] = status_data
        end
      else
        seats[seat_id] = status_data
      end
    else
      seats[seat_id] = nil
    end
  end
else
  -- Get all seats
  local all_seats = redis.call('HGETALL', seats_key)

  for i = 1, #all_seats, 2 do
    local seat_id = all_seats[i]
    local seat_data_raw = all_seats[i + 1]

    if seat_data_raw then
      local status_data = cjson.decode(seat_data_raw)

      -- Check for expired holds
      if status_data.status == 'held' then
        local held_until = tonumber(status_data.held_until) or 0
        if held_until < now then
          -- Expired - clean up
          local available_data = {
            status = 'available',
            seat_type = status_data.seat_type,
            released_at = now,
            released_reason = 'HOLD_EXPIRED'
          }
          redis.call('HSET', seats_key, seat_id, cjson.encode(available_data))
          redis.call('INCR', available_key)
          expired_cleaned = expired_cleaned + 1
          seats[seat_id] = available_data
        else
          status_data.remaining_seconds = held_until - now
          seats[seat_id] = status_data
        end
      else
        seats[seat_id] = status_data
      end
    end
  end
end

-- Get current available count
local available_count = tonumber(redis.call('GET', available_key)) or 0
local total_seats = redis.call('HLEN', seats_key)

return cjson.encode({
  success = true,
  seats = seats,
  available_count = available_count,
  total_seats = total_seats,
  expired_cleaned = expired_cleaned,
  timestamp = now
})
