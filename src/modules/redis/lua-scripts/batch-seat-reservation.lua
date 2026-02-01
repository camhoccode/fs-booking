--[[
  Batch Seat Reservation Script
  Atomically reserves multiple seats with all-or-nothing semantics

  KEYS[1]: showtime:{showtimeId}:seats (Hash containing seat status)
  KEYS[2]: showtime:{showtimeId}:available (Atomic counter)

  ARGV[1]: booking_id
  ARGV[2]: hold_expire_time (Unix timestamp)
  ARGV[3]: number of seats
  ARGV[4..n]: seat_id:seat_type pairs (e.g., "A1:standard", "A2:vip")

  Returns JSON:
    {success: true, message: "SUCCESS", reserved: N} - All seats reserved
    {success: false, message: "SEATS_UNAVAILABLE", unavailable: [...]} - Some seats unavailable
    {success: false, message: "INVALID_INPUT", error: "..."} - Invalid input
]]

local seats_key = KEYS[1]
local available_key = KEYS[2]
local booking_id = ARGV[1]
local hold_expire = tonumber(ARGV[2])
local seat_count = tonumber(ARGV[3])

-- Validate input
if not booking_id or booking_id == '' then
  return cjson.encode({success = false, message = 'INVALID_INPUT', error = 'booking_id is required'})
end

if not hold_expire or hold_expire <= 0 then
  return cjson.encode({success = false, message = 'INVALID_INPUT', error = 'hold_expire must be positive'})
end

if not seat_count or seat_count <= 0 then
  return cjson.encode({success = false, message = 'INVALID_INPUT', error = 'seat_count must be positive'})
end

-- Get current timestamp from Redis server
local now = tonumber(redis.call('TIME')[1])

-- Parse seat info into structured data
local seats = {}
for i = 1, seat_count do
  local seat_info = ARGV[3 + i]
  if not seat_info then
    return cjson.encode({success = false, message = 'INVALID_INPUT', error = 'missing seat info at index ' .. i})
  end

  local seat_id, seat_type = seat_info:match("([^:]+):([^:]+)")
  if not seat_id or not seat_type then
    return cjson.encode({success = false, message = 'INVALID_INPUT', error = 'invalid seat format: ' .. seat_info})
  end

  table.insert(seats, {id = seat_id, type = seat_type})
end

--[[
  PHASE 1: Check all seats are available
  This ensures all-or-nothing semantics
]]
local unavailable_seats = {}
local seats_to_check = {}

for _, seat in ipairs(seats) do
  local current_status = redis.call('HGET', seats_key, seat.id)

  if not current_status then
    -- Seat doesn't exist - treat as unavailable
    table.insert(unavailable_seats, {id = seat.id, reason = 'NOT_FOUND'})
  else
    local status_data = cjson.decode(current_status)

    if status_data.status == 'booked' then
      table.insert(unavailable_seats, {id = seat.id, reason = 'BOOKED'})
    elseif status_data.status == 'held' then
      local held_until = tonumber(status_data.held_until) or 0
      if held_until > now then
        table.insert(unavailable_seats, {id = seat.id, reason = 'HELD', held_by = status_data.booking_id})
      else
        -- Hold expired - can be reserved
        table.insert(seats_to_check, {seat = seat, current = status_data, was_available = false})
      end
    else
      -- Available
      table.insert(seats_to_check, {seat = seat, current = status_data, was_available = true})
    end
  end
end

-- If any seat is unavailable, return error with full list
if #unavailable_seats > 0 then
  return cjson.encode({
    success = false,
    message = 'SEATS_UNAVAILABLE',
    unavailable = unavailable_seats
  })
end

--[[
  PHASE 2: Reserve all seats atomically
  Only executes if all seats passed validation
]]
local reserved_count = 0
local available_decrement = 0

for _, check in ipairs(seats_to_check) do
  local seat_data = cjson.encode({
    status = 'held',
    booking_id = booking_id,
    held_until = hold_expire,
    seat_type = check.seat.type,
    reserved_at = now
  })

  redis.call('HSET', seats_key, check.seat.id, seat_data)
  reserved_count = reserved_count + 1

  if check.was_available then
    available_decrement = available_decrement + 1
  end
end

-- Decrement available counter atomically
if available_decrement > 0 then
  redis.call('DECRBY', available_key, available_decrement)
end

return cjson.encode({
  success = true,
  message = 'SUCCESS',
  reserved = reserved_count,
  booking_id = booking_id,
  expires_at = hold_expire
})
