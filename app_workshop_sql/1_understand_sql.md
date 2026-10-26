1) write a prompt to help you understand a query


```sql
SELECT                                                                                                                                                                                                                                                                                                                                                                           
enrollment_date,                                                                                                                                                                                                                                                                                                                                                             
enrolled_patients,                                                                                                                                                                                                                                                                                                                                                           
SUM(enrolled_patients) OVER (ORDER BY enrollment_date) AS cumulative_enrolled                                                                                                                                                                                                                                                                                                
FROM (                                                                                                                                                                                                                                                                                                                                                                           
SELECT DATE(created_at) AS enrollment_date, COUNT(*) AS enrolled_patients                                                                                                                                                                                                                                                                                                    
FROM patients_enrollments                                                                                                                                                                                                                                                                                                                                                    
GROUP BY DATE(created_at)                                                                                                                                                                                                                                                                                                                                                    
) t                                                                                                                                                                                                                                                                                                                                                                              
ORDER BY enrollment_date;  
```


2) write a prompt to help you explain a stored procedure:


```sql
DELIMITER //

CREATE PROCEDURE sp_process_order(
    IN p_order_id INT,
    OUT p_result_code INT,
    OUT p_result_message VARCHAR(255)
)
    main_block: BEGIN

    DECLARE v_customer_id INT;
    DECLARE v_customer_status VARCHAR(20);
    DECLARE v_credit_limit DECIMAL(12,2);
    DECLARE v_balance DECIMAL(12,2);

    DECLARE v_order_status VARCHAR(20);
    DECLARE v_total DECIMAL(12,2) DEFAULT 0;

    DECLARE v_product_id INT;
    DECLARE v_quantity INT;
    DECLARE v_price DECIMAL(12,2);
    DECLARE v_stock INT;

    DECLARE v_done BOOLEAN DEFAULT FALSE;
    DECLARE v_error BOOLEAN DEFAULT FALSE;

    DECLARE cur_items CURSOR FOR
SELECT product_id, quantity, unit_price
FROM order_items
WHERE order_id = p_order_id;

DECLARE CONTINUE HANDLER FOR NOT FOUND
        SET v_done = TRUE;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
BEGIN
ROLLBACK;
SET p_result_code = -99;
        SET p_result_message = 'Unexpected database error';
END;

    SET p_result_code = 0;
    SET p_result_message = 'Processing started';

START TRANSACTION;

-- Load order information
SELECT customer_id, status
INTO v_customer_id, v_order_status
FROM orders
WHERE id = p_order_id;

IF v_order_status <> 'PENDING' THEN
        ROLLBACK;
        SET p_result_code = -1;
        SET p_result_message = 'Order is not pending';
        LEAVE main_block;
END IF;

    -- Load customer information
SELECT status, credit_limit, outstanding_balance
INTO v_customer_status, v_credit_limit, v_balance
FROM customers
WHERE id = v_customer_id;

IF v_customer_status <> 'ACTIVE' THEN
        ROLLBACK;
        SET p_result_code = -2;
        SET p_result_message = 'Customer is not active';
        LEAVE main_block;
END IF;

    -- Calculate order total
SELECT COALESCE(SUM(quantity * unit_price), 0)
INTO v_total
FROM order_items
WHERE order_id = p_order_id;

IF v_balance + v_total > v_credit_limit THEN
UPDATE orders
SET status = 'REJECTED'
WHERE id = p_order_id;

INSERT INTO order_audit (
    order_id, action, description
)
VALUES (
           p_order_id,
           'REJECTED',
           'Customer credit limit exceeded'
       );

COMMIT;

SET p_result_code = -3;
        SET p_result_message = 'Credit limit exceeded';
        LEAVE main_block;
END IF;

    -- Validate inventory and reduce stock
OPEN cur_items;

item_loop: LOOP

        FETCH cur_items
        INTO v_product_id, v_quantity, v_price;

        IF v_done THEN
            LEAVE item_loop;
END IF;

SELECT stock_quantity
INTO v_stock
FROM products
WHERE id = v_product_id;

IF v_stock < v_quantity THEN
            SET v_error = TRUE;
            LEAVE item_loop;
END IF;

UPDATE products
SET stock_quantity = stock_quantity - v_quantity
WHERE id = v_product_id;

END LOOP;

CLOSE cur_items;

IF v_error THEN
        ROLLBACK;

        SET p_result_code = -4;
        SET p_result_message = 'Insufficient inventory';

        LEAVE main_block;
END IF;

    -- Update customer balance
UPDATE customers
SET outstanding_balance = outstanding_balance + v_total
WHERE id = v_customer_id;

-- Complete order
UPDATE orders
SET status = 'COMPLETED',
    total_amount = v_total,
    processed_at = NOW()
WHERE id = p_order_id;

INSERT INTO order_audit (
    order_id, action, description
)
VALUES (
           p_order_id,
           'COMPLETED',
           CONCAT('Order processed. Total: ', v_total)
       );

COMMIT;

SET p_result_code = 1;
    SET p_result_message = 'Order completed successfully';

END main_block //

DELIMITER ;

```

data model
```sql
CREATE TABLE customers (
id INT PRIMARY KEY AUTO_INCREMENT,
name VARCHAR(100),
credit_limit DECIMAL(12,2) NOT NULL DEFAULT 0,
outstanding_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
status ENUM('ACTIVE', 'SUSPENDED') DEFAULT 'ACTIVE'
);

CREATE TABLE products (
id INT PRIMARY KEY AUTO_INCREMENT,
name VARCHAR(100),
stock_quantity INT NOT NULL,
unit_price DECIMAL(12,2) NOT NULL
);

CREATE TABLE orders (
id INT PRIMARY KEY AUTO_INCREMENT,
customer_id INT NOT NULL,
status ENUM('PENDING', 'COMPLETED', 'REJECTED') DEFAULT 'PENDING',
total_amount DECIMAL(12,2) DEFAULT 0,
processed_at DATETIME NULL,
FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE order_items (
id INT PRIMARY KEY AUTO_INCREMENT,
order_id INT NOT NULL,
product_id INT NOT NULL,
quantity INT NOT NULL,
unit_price DECIMAL(12,2) NOT NULL,
FOREIGN KEY (order_id) REFERENCES orders(id),
FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE order_audit (
id INT PRIMARY KEY AUTO_INCREMENT,
order_id INT,
action VARCHAR(50),
description TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```